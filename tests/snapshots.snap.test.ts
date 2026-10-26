import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DROPPED_CLAIM, llmCalls, resetLlmCalls } from './fixture-llm.ts';

vi.mock('../src/llm/runners.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/runners.ts')>();
  const { llmText } = await import('./fixture-llm.ts');
  return {
    ...actual,
    embed: async () => null,
    ask: async (_order: string[], prompt: string, validate: (v: unknown) => unknown) => ({
      value: validate(actual.parseJson(llmText(prompt))),
      provider: 'fixture',
    }),
  };
});

import { IncompatibleFlagsError, agyCli } from '../src/cli-tool.ts';
import { pdfExtractFromText, type Extracted } from '../src/capture/extract.ts';
import { captureOne, commitCapture } from '../src/stages/capture.ts';
import { runProcess } from '../src/stages/process.ts';
import { runReflect } from '../src/stages/reflect.ts';
import { initKnowledge } from '../src/init.ts';
import { buildIndex } from '../src/indexer.ts';
import { parseJson, providerInvocation } from '../src/llm/runners.ts';
import { backlinks, search, stats } from '../src/query.ts';
import { opsMetrics } from '../src/ops.ts';
import * as Q from '../src/queue.ts';
import { propose, review } from '../src/conversation-knowledge.ts';
import { kpath } from '../src/config.ts';
import { normalizeUrl, platformOf, readDoc, walk } from '../src/util.ts';
import { verifyAll } from '../src/verify.ts';

const CLOCK = '2026-10-26T08:00:00.000Z';

const URLS = {
  deep: 'https://example.com/articles/failure-modes',
  light: 'https://example.com/articles/deploy-checklist?utm_source=newsletter&utm_medium=email',
  archive: 'https://example.com/ads/launch',
  forced: 'https://m.example.com/notes/forced-deep',
  clipper: 'https://www.example.com/glossary?utm_source=clip',
  pdf: 'https://example.com/papers/evaluation-failures.pdf?utm_campaign=spring',
};

const DEEP_BODY =
  'Score the failure, not only the final answer. A single accuracy number hides a regression when the model fails in a new way. Teams should label the failure mode before they publish a score. The rubric has to be public so a later reader can compare two runs. This paragraph is long enough to pass the short text archive rule and to stay a complete capture.';
const LIGHT_BODY =
  'Write the failure mode before the score. Check that the rubric is attached. Do not treat a flat accuracy line as proof that nothing changed. Keep this as a checklist rather than a claim. The paragraph is long enough to avoid the archive rule and the partial save rule.';
const ARCHIVE_BODY = 'Limited offer today only buy now free gift click here fast ends soon extra deal wow';
const FORCED_BODY = 'Keep this short on purpose so the archive rule would fire without the force deep flag set';
const PDF_TEXT = [
  'Evaluation Failures in Practice',
  '',
  'Accuracy alone hid the regression in the May release.',
  'Table 2 keeps the headline score flat while the failure mix moves.',
  'The sign of each delta is the part a reader must check against the original.',
  'doi: 10.1145/3290605.3300233.',
  '',
  '\f',
  'The second page repeats the warning and adds a short method note for the archive rule.',
  'We counted these words so triage does not file the paper as a short text.',
  'Trailing spaces should disappear from the stored line.   ',
  '',
  '\f',
  'Appendix starts here with another sentence so the page count includes a third page marker.',
].join('\n');

function table(headers: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => esc(cell || '')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`;
}

function clearQueue() {
  const dir = process.env.QUEUE_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
}

function byUrl(url: string): Q.Item {
  const key = normalizeUrl(url);
  const item = Q.all().find((i) => i.url === key);
  if (!item) throw new Error(`대기열에 없음: ${key}`);
  return item;
}

function relOf(file: string): string {
  return path.relative(process.env.KNOWLEDGE_DIR!, file).split(path.sep).join('/');
}

function page(title: string, paragraph: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="author" content="Ada Lovelace"><meta property="article:published_time" content="2026-09-01"></head><body><article><h1>${title}</h1><p>${paragraph}</p></article></body></html>`;
}

function runArgv(argv: readonly string[]) {
  try {
    const got = agyCli.args(argv as never);
    return { outcome: 'accepted', detail: got.length ? got.join(' ') : '(empty)' };
  } catch (e) {
    if (e instanceof IncompatibleFlagsError) return { outcome: 'rejected', detail: e.message };
    throw e;
  }
}

function formatCall(name: string, prompt: string): string {
  const call = providerInvocation(name, prompt);
  const argv = call.argv.map((arg, i) => `  ${i + 1}. ${arg.replace(/\n/g, '\\n')}`).join('\n');
  const stdin = call.stdin ? call.stdin.replace(/\n/g, '\\n') : '(none)';
  return [`${name}`, `command: ${call.command}`, `stdin: ${stdin}`, `timeoutMs: ${call.timeoutMs ?? '(default)'}`, 'argv:', argv].join('\n');
}

function showParse(label: string, text: string): string {
  try {
    return `${label}\n${JSON.stringify(parseJson(text))}`;
  } catch (e) {
    return `${label}\nerror: ${(e as Error).message}`;
  }
}

function pdfLines(label: string, extracted: Extracted): string {
  const log = extracted.extract_log || {};
  return [
    `### ${label}`,
    `- title: ${extracted.title}`,
    `- extractor: ${extracted.extractor}`,
    `- words: ${extracted.wordCount}`,
    `- doi: ${extracted.doi || '-'}`,
    `- pages: ${log.pages}`,
    `- args: ${log.args}`,
    `- at: ${log.at}`,
    '',
    extracted.markdown,
  ].join('\n');
}

function dumpDocs(): string {
  const root = process.env.KNOWLEDGE_DIR!;
  const files = walk(root)
    .map(relOf)
    .filter((rel) => rel.startsWith('raw/') || rel.startsWith('notes/') || rel.startsWith('topics/'));
  return files.map((rel) => `### ${rel}\n\n${fs.readFileSync(path.join(root, rel), 'utf8').trimEnd()}`).join('\n\n');
}

async function searchBlock(q: string, opts: { types?: string[]; limit?: number } = {}): Promise<string> {
  const hits = await search(q, { limit: opts.limit ?? 5, types: opts.types });
  const rows = hits.map((hit, i) => [
    String(i + 1),
    hit.type,
    hit.title,
    (hit.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    hit.path,
  ]);
  const head = `query: ${q}${opts.types ? `  types: ${opts.types.join(',')}` : ''}`;
  return `${head}\n${rows.length ? table(['#', 'type', 'title', 'snippet', 'path'], rows) : '(no hits)'}`;
}

it('prints CLI flag combinations, including the incompatible pair', () => {
  const pairs = agyCli.incompatible.map(([left, right, fix]) => `- ${left}  +  ${right}  →  ${fix}`).join('\n');
  const cases: [string, readonly string[]][] = [
    ['sandbox + disable slash commands', ['--sandbox', '--disable-slash-commands', '--model', 'gemini-3.8-flash-low', '-p', 'prompt']],
    ['sandbox alone', ['--sandbox', '-p', 'prompt']],
    ['disable slash commands alone', ['--disable-slash-commands', '-p', 'prompt']],
    ['mode plan alone', ['--mode', 'plan', '-p', 'prompt']],
    ['mode plan then disable', ['--mode', 'plan', '--disable-slash-commands', '-p', 'prompt']],
    ['disable then mode plan', ['--disable-slash-commands', '--model', 'm', '--mode', 'plan']],
    ['mode plan, model, then disable', ['--mode', 'plan', '--model', 'm', '--disable-slash-commands']],
    ['repeated disable still rejects mode plan', ['--disable-slash-commands', '--disable-slash-commands', '--mode', 'plan']],
    ['sandbox + mode plan, slash commands still enabled', ['--sandbox', '--mode', 'plan', '-p', 'prompt']],
    ['sandbox + disable + mode plan', ['--sandbox', '--disable-slash-commands', '--mode', 'plan']],
    ['equals form is one token, so the pair is not detected', ['--mode=plan', '--disable-slash-commands']],
    ['prompt value is one argv, not a flag span', ['--disable-slash-commands', '-p', '--mode plan']],
    ['empty argv', []],
  ];
  const rows = cases.map(([name, argv]) => {
    const result = runArgv(argv);
    return [name, argv.join(' ') || '(empty)', result.outcome, result.detail];
  });
  const rejected = rows.filter((row) => row[2] === 'rejected');
  expect(rejected.map((row) => row[0])).toEqual([
    'mode plan then disable',
    'disable then mode plan',
    'mode plan, model, then disable',
    'repeated disable still rejects mode plan',
    'sandbox + disable + mode plan',
  ]);
  for (const row of rejected) {
    expect(row[3]).toBe('agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan');
  }
  const agy = providerInvocation('agy', '샘플');
  expect(agy.argv).toContain('--sandbox');
  expect(agy.argv).not.toContain('--mode');
  expect(agy.argv.join('\n')).not.toContain('plan');

  const report = [
    '# CLI flag combinations',
    '',
    'tool: agy',
    `paths: ${agyCli.candidatePaths.join(', ')}`,
    'registered incompatible pairs:',
    pairs,
    '',
    table(['case', 'argv', 'outcome', 'detail'], rows),
    '',
    '## argv the runners actually build',
    '',
    formatCall('agy', '샘플'),
    '',
    formatCall('codex', '샘플'),
    '',
    formatCall('claude', '샘플'),
    '',
    '## parseJson',
    '',
    showParse('fenced', '```json\n{"tier":"deep","reason":"ok"}\n```'),
    '',
    showParse('prose around one object', '결과는 다음과 같다.\n{"tier":"light","reason":"참고"}\n이상.'),
    '',
    showParse('no object', 'JSON 없이 설명만 있다.'),
  ].join('\n');

  expect(report).toMatchInlineSnapshot(`
    "# CLI flag combinations

    tool: agy
    paths: agy
    registered incompatible pairs:
    - --mode plan  +  --disable-slash-commands  →  use --sandbox instead of --mode plan

    | case | argv | outcome | detail |
    | --- | --- | --- | --- |
    | sandbox + disable slash commands | --sandbox --disable-slash-commands --model gemini-3.8-flash-low -p prompt | accepted | --sandbox --disable-slash-commands --model gemini-3.8-flash-low -p prompt |
    | sandbox alone | --sandbox -p prompt | accepted | --sandbox -p prompt |
    | disable slash commands alone | --disable-slash-commands -p prompt | accepted | --disable-slash-commands -p prompt |
    | mode plan alone | --mode plan -p prompt | accepted | --mode plan -p prompt |
    | mode plan then disable | --mode plan --disable-slash-commands -p prompt | rejected | agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan |
    | disable then mode plan | --disable-slash-commands --model m --mode plan | rejected | agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan |
    | mode plan, model, then disable | --mode plan --model m --disable-slash-commands | rejected | agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan |
    | repeated disable still rejects mode plan | --disable-slash-commands --disable-slash-commands --mode plan | rejected | agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan |
    | sandbox + mode plan, slash commands still enabled | --sandbox --mode plan -p prompt | accepted | --sandbox --mode plan -p prompt |
    | sandbox + disable + mode plan | --sandbox --disable-slash-commands --mode plan | rejected | agy: --mode plan together with --disable-slash-commands is a no-op. Fix: use --sandbox instead of --mode plan |
    | equals form is one token, so the pair is not detected | --mode=plan --disable-slash-commands | accepted | --mode=plan --disable-slash-commands |
    | prompt value is one argv, not a flag span | --disable-slash-commands -p --mode plan | accepted | --disable-slash-commands -p --mode plan |
    | empty argv | (empty) | accepted | (empty) |

    ## argv the runners actually build

    agy
    command: agy
    stdin: (none)
    timeoutMs: 90000
    argv:
      1. --sandbox
      2. --disable-slash-commands
      3. --model
      4. gemini-3.8-flash-low
      5. -p
      6. 샘플\\n\\n위 지시를 따르세요. 파일을 만들거나 도구를 쓰지 말고, 설명 없이 JSON 한 개만 출력하세요.

    codex
    command: codex
    stdin: (none)
    timeoutMs: (default)
    argv:
      1. exec
      2. --skip-git-repo-check
      3. -s
      4. read-only
      5. 샘플\\n\\n위 지시를 따르세요. 파일을 만들거나 도구를 쓰지 말고, 설명 없이 JSON 한 개만 출력하세요.

    claude
    command: claude
    stdin: 샘플\\n\\n위 지시를 따르세요. 파일을 만들거나 도구를 쓰지 말고, 설명 없이 JSON 한 개만 출력하세요.
    timeoutMs: (default)
    argv:
      1. -p
      2. --output-format
      3. text
      4. --disallowedTools
      5. Bash,Edit,Write,WebFetch,WebSearch,Task

    ## parseJson

    fenced
    {"tier":"deep","reason":"ok"}

    prose around one object
    {"tier":"light","reason":"참고"}

    no object
    error: JSON 없음"
  `);
});

afterEach(() => {
  vi.useRealTimers();
});

it('prints sample captures after triage, reduce, reflect, search, and ops', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK));
  resetLlmCalls();
  initKnowledge();

  expect(platformOf('https://notlinkedin.com/jobs')).toBe('web');
  expect(platformOf('https://mytwitter.com/i/status/1')).toBe('web');
  expect(platformOf('https://twitter.com/alice/status/1')).toBe('x');
  expect(platformOf('https://www.linkedin.com/in/a')).toBe('linkedin');
  expect(platformOf('https://threads.net/@a/post/1')).toBe('threads');
  expect(platformOf('https://example.com/papers/note.PDF')).toBe('pdf');

  const intakeInputs: [string, { memo?: string; forceDeep?: boolean }?][] = [
    ['https://mobile.twitter.com/alice/status/1?s=20&t=99'],
    ['https://www.linkedin.com/posts/a?trk=public'],
    ['https://www.threads.net/@u/post/1'],
    ['https://example.com/a/b.PDF?utm_source=x'],
    ['https://notlinkedin.com/jobs'],
    ['https://mytwitter.com/i/status/1'],
    ['https://news.ycombinator.com/item?id=1'],
    ['https://youtu.be/abc?t=120'],
    ['https://m.wikipedia.org/wiki/Seoul'],
    ['https://mobile.twitter.com/alice/status/1?s=20&t=99'],
    ['https://mobile.twitter.com/alice/status/1?s=20&t=99', { forceDeep: true, memo: '다시 깊게' }],
  ];
  const intakeRows = intakeInputs.map(([url, opts]) => {
    const result = Q.enqueue({ url, memo: opts?.memo, forceDeep: opts?.forceDeep, origin: 'cli' });
    return [
      url,
      result.item.url,
      result.item.platform,
      result.duplicate ? 'yes' : 'no',
      result.promoted ? 'yes' : 'no',
      result.item.status,
      result.item.tier || '-',
      result.item.force_deep ? 'yes' : 'no',
      result.item.memo || '-',
      result.item.id,
    ];
  });
  const intake = table(['input', 'normalized', 'platform', 'duplicate', 'promoted', 'status', 'tier', 'force_deep', 'memo', 'id'], intakeRows);
  const twitter = Q.all().find((item) => item.url === 'https://x.com/alice/status/1');
  expect(twitter?.force_deep).toBe(true);
  expect(twitter?.status).toBe('queued');
  expect(twitter?.tier).toBe('deep');
  expect(twitter?.memo).toBe('다시 깊게');
  clearQueue();

  const queued = Q.enqueue({ url: 'https://example.com/queued-only', origin: 'cli' }).item;
  const promotedQueued = Q.promote(queued.id);
  const failed = Q.enqueue({ url: 'https://example.com/failed-capture', origin: 'cli' }).item;
  failed.status = 'failed';
  failed.attempts = 2;
  failed.error = 'boom';
  Q.save(failed);
  const promotedFailed = Q.promote(failed.id);
  const waiting = Q.enqueue({ url: 'https://example.com/need-login', origin: 'cli' }).item;
  waiting.status = 'waiting';
  waiting.waiting_stage = 'queued';
  waiting.error = 'login';
  Q.save(waiting);
  const promotedWaiting = Q.promote(waiting.id);
  expect(Q.promote('missing')).toBeNull();
  expect(promotedQueued?.status).toBe('queued');
  expect(promotedQueued?.raw).toBeUndefined();
  expect(promotedQueued?.tier).toBe('deep');
  expect(promotedFailed?.status).toBe('queued');
  expect(promotedFailed?.attempts).toBe(0);
  expect(promotedFailed?.error).toBeUndefined();
  expect(promotedWaiting?.status).toBe('waiting');
  expect(promotedWaiting?.waiting_stage).toBe('queued');
  const promoteRows = [
    ['missing id', '-', '-', '-', '-', '-'],
    ['queued, no raw', promotedQueued!.status, promotedQueued!.tier || '-', promotedQueued!.waiting_stage || '-', String(promotedQueued!.attempts), promotedQueued!.error || '-'],
    ['failed, no raw', promotedFailed!.status, promotedFailed!.tier || '-', promotedFailed!.waiting_stage || '-', String(promotedFailed!.attempts), promotedFailed!.error || '-'],
    ['waiting for login, no raw', promotedWaiting!.status, promotedWaiting!.tier || '-', promotedWaiting!.waiting_stage || '-', String(promotedWaiting!.attempts), promotedWaiting!.error || '-'],
  ];
  const promote = table(['case', 'status', 'tier', 'waiting_stage', 'attempts', 'error'], promoteRows);
  clearQueue();

  const fixtureDir = path.join(process.env.SNAP_ROOT!, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const html = (name: string, title: string, paragraph: string) => {
    const file = path.join(fixtureDir, name);
    fs.writeFileSync(file, page(title, paragraph));
    return file;
  };
  const captured: { url: string; memo?: string; forceDeep?: boolean; file?: string }[] = [
    { url: URLS.deep, memo: '평가 기준을 다시 쓰려고', file: html('deep.html', '실패 유형이 먼저다', DEEP_BODY) },
    { url: URLS.light, file: html('light.html', '배포 체크리스트', LIGHT_BODY) },
    { url: URLS.archive, file: html('archive.html', '홍보', ARCHIVE_BODY) },
    { url: URLS.forced, memo: '규칙보다 우선', forceDeep: true, file: html('forced.html', '짧은 글', FORCED_BODY) },
  ];
  for (const sample of captured) {
    const item = Q.enqueue({ url: sample.url, file: sample.file, memo: sample.memo, forceDeep: sample.forceDeep, origin: 'cli' }).item;
    expect(await captureOne(item), sample.url).toBe(true);
  }
  const clipperFile = path.join(fixtureDir, 'clipper.md');
  fs.writeFileSync(
    clipperFile,
    `---\ntitle: 클리퍼 체크리스트\nauthor:\n  - "[[Ada Lovelace]]"\nsource: https://www.example.com/glossary?utm_source=clip\npublished: 2026-08-01\ndescription: 수동으로 저장한 용어 메모\n---\n\n# 클리퍼 체크리스트\n\nWrite the term in Korean first and keep the English in parentheses. This file is the manual Web Clipper path, not a browser render. The body has enough words to stay out of the archive rule and the partial rule. Glossary entries are reference material, so this one stays light.\n`,
  );
  const clipper = Q.enqueue({ url: URLS.clipper, file: clipperFile, origin: 'cli' }).item;
  expect(await captureOne(clipper)).toBe(true);

  const shaped = pdfExtractFromText({
    text: PDF_TEXT,
    fallbackTitle: 'evaluation-failures.pdf',
    infoTitle: '2401.12345',
    version: 'poppler-fixture',
    at: CLOCK,
  });
  expect(shaped.title).toBe('Evaluation Failures in Practice');
  expect(shaped.extractor).toBe('pdftotext');
  expect(shaped.wordCount).toBeGreaterThanOrEqual(25);
  expect(shaped.doi).toBe('10.1145/3290605.3300233');
  expect(shaped.extract_log?.pages).toBe('3');
  expect(shaped.markdown).not.toMatch(/[ \t]\n/);
  const pdfItem = Q.enqueue({ url: URLS.pdf, origin: 'cli' }).item;
  pdfItem.attempts = 1;
  await commitCapture(pdfItem, shaped);

  const emptyPdf = pdfExtractFromText({ text: '', fallbackTitle: 'scan.pdf', version: 'poppler-fixture', at: CLOCK });
  const keptTitle = pdfExtractFromText({
    text: 'Proceedings of the Conference\n\nThis line would have been the title if the info title were missing or an arxiv id.\n',
    fallbackTitle: 'fallback.pdf',
    infoTitle: 'Methods That Survive Contact',
    version: 'poppler-fixture',
    at: CLOCK,
  });
  const skippedTitle = pdfExtractFromText({
    text: 'arXiv:2401.12345\n1\nProceedings of the Conference on Stuff\nCopyright 2026\nFailure Modes as the Unit of Evaluation\n',
    fallbackTitle: '2401.12345.pdf',
    infoTitle: '2401.12345',
    version: 'poppler-fixture',
    at: CLOCK,
  });
  expect(emptyPdf.extractor).toBe('pdftotext:empty(스캔 PDF 가능성)');
  expect(emptyPdf.title).toBe('scan.pdf');
  expect(keptTitle.title).toBe('Methods That Survive Contact');
  expect(skippedTitle.title).toBe('Failure Modes as the Unit of Evaluation');

  for (const item of Q.all()) {
    const data = readDoc(kpath(item.raw!)).data;
    expect(data.quality, `${item.url} words=${data.word_count}`).toBe('complete');
  }
  const archiveRaw = readDoc(kpath(byUrl(URLS.archive).raw!)).data;
  const forcedRaw = readDoc(kpath(byUrl(URLS.forced).raw!)).data;
  expect(archiveRaw.word_count, 'archive word_count').toBeLessThan(25);
  expect(archiveRaw.word_count, 'archive word_count').toBeGreaterThanOrEqual(15);
  expect(forcedRaw.word_count, 'forced word_count').toBeLessThan(25);

  await runProcess();
  const failedItems = Q.all().filter((item) => item.status === 'failed');
  expect(failedItems.map((item) => `${item.id} ${item.error || ''}`)).toEqual([]);
  expect(byUrl(URLS.archive).tier).toBe('archive');
  expect(byUrl(URLS.archive).status).toBe('done');
  expect(byUrl(URLS.forced).tier).toBe('deep');
  expect(byUrl(URLS.light).tier).toBe('light');
  expect(byUrl(URLS.deep).tier).toBe('deep');
  expect(byUrl(URLS.pdf).tier).toBe('deep');
  expect(llmCalls.map((call) => call.title)).not.toContain('홍보');
  expect(llmCalls.some((call) => call.stage === 'triage' && call.title.includes('짧은'))).toBe(false);
  expect(llmCalls.some((call) => call.stage === 'reduce' && call.title.includes('짧은'))).toBe(true);

  await runReflect();
  expect(byUrl(URLS.deep).status).toBe('done');
  expect(byUrl(URLS.light).status).toBe('done');
  const noteBlob = walk(kpath('notes'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  expect(noteBlob).not.toContain(DROPPED_CLAIM);
  const topicBlob = walk(kpath('topics'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  expect(topicBlob).not.toContain('[[없는 노트');
  expect(topicBlob).toContain('빠진 절');
  expect(topicBlob).toMatch(/\[\[[^\]]+#기준\]\]/);
  const clipperRaw = fs.readFileSync(kpath(byUrl(URLS.clipper).raw!), 'utf8');
  expect(clipperRaw.match(/^# 클리퍼 체크리스트$/gm)?.length).toBe(1);
  expect(readDoc(kpath('notes', 'sources', `${byUrl(URLS.pdf).id}.md`)).data.reflected).toBe(true);
  expect(readDoc(kpath('notes', 'sources', `${byUrl(URLS.deep).id}.md`)).data.reflected).toBe(true);
  const problems = verifyAll();
  expect(problems).toEqual([]);

  await buildIndex({ embeddings: false });
  const claimFile = walk(kpath('notes')).find((file) => path.basename(file).startsWith('LLM 평가는'));
  if (!claimFile) throw new Error('deep claim note missing');
  const claimPath = relOf(claimFile);
  const back = backlinks(claimPath) as { type: string; title: string; path: string }[];
  const st = stats();
  const searchBefore = [
    await searchBlock('failure'),
    await searchBlock('실패 유형'),
    await searchBlock('체크리스트'),
    await searchBlock('LLM', { types: ['claim'] }),
    await searchBlock('of'),
  ].join('\n\n');
  const ops = opsMetrics(3);
  const platformRows = Object.entries(ops.platform).map(([name, counts]) => [name, String(counts.total), String(counts.captured), String(counts.failed), String(counts.waiting)]);

  const queueRows = Q.all().map((item) => [item.id, item.status, item.tier || '-', item.force_deep ? 'yes' : 'no', item.platform, item.raw || '-', item.title || '-']);
  const docs = dumpDocs();

  const reopened = Q.enqueue({ url: URLS.archive, forceDeep: true, memo: '보관만이었던 글을 깊게', origin: 'cli' });
  expect(reopened.duplicate).toBe(true);
  expect(reopened.promoted).toBe(true);
  expect(reopened.item.status).toBe('triaged');
  expect(reopened.item.tier).toBe('deep');

  const proposed = await propose({
    kind: 'decision',
    project: 'info-processing',
    title: '대화에서 확정한 평가 원칙',
    content: '기존 접근을 유지한다. 평가원칙토큰 은 승인 후에만 색인된다. 이 문장은 길이를 넘긴다.',
    evidence: ['https://example.com/articles/failure-modes'],
    conversation_ref: 'conversation:snapshot',
  });
  const duplicate = await propose({
    kind: 'decision',
    project: 'info-processing',
    title: '대화에서 확정한 평가 원칙',
    content: '기존 접근을 유지한다. 평가원칙토큰 은 승인 후에만 색인된다. 이 문장은 길이를 넘긴다.',
    evidence: ['https://example.com/articles/failure-modes'],
    conversation_ref: 'conversation:snapshot',
  });
  expect(proposed.status).toBe('pending_review');
  expect(duplicate.status).toBe('duplicate');
  const approved = review(proposed.id, 'approve');
  const notePath = approved.note_path || '';
  const noteBody = fs.readFileSync(path.join(process.env.KNOWLEDGE_DIR!, notePath), 'utf8').replaceAll(proposed.id, 'conv-<id>');
  const beforeIndex = await search('평가원칙토큰', { limit: 5 });
  expect(beforeIndex).toEqual([]);
  await buildIndex({ embeddings: false });
  const afterIndex = await search('평가원칙토큰', { limit: 5 });
  expect(afterIndex.map((hit) => hit.type)).toContain('conversation');

  const typeRows = Object.entries(st.byType).map(([type, count]) => [type, String(count)]);
  const report = [
    '# Processing paths',
    '',
    `clock: ${CLOCK}`,
    'LLM replies are fixture JSON passed through parseJson. Embeddings are off. pdftotext is not executed; PDF text is shaped by pdfExtractFromText and stored with commitCapture.',
    '',
    section('1. URL intake', intake),
    section('2. Promote when there is no raw file', 'missing id → null\n\n' + promote),
    section('3. LLM calls', table(['#', 'stage', 'title'], llmCalls.map((call, i) => [String(i + 1), call.stage, call.title]))),
    section('4. Queue after distill', table(['id', 'status', 'tier', 'force_deep', 'platform', 'raw', 'title'], queueRows)),
    section('5. Documents', docs),
    section('6. Verify', problems.length ? problems.map((problem) => `- ${problem}`).join('\n') : '문제 없음'),
    section('7. Search', `${searchBefore}\n\nbacklinks of ${claimPath}\n${table(['type', 'title', 'path'], back.map((row) => [row.type, row.title, row.path]))}`),
    section(
      '8. Index stats',
      `${table(['type', 'count'], typeRows)}\n\nbuilt_at: ${st.built}`,
    ),
    section(
      '9. Ops (3 days)',
      [
        table(
          ['metric', 'value'],
          [
            ['generated_at', ops.generated_at],
            ['total', String(ops.total)],
            ['attempted', String(ops.attempted)],
            ['captured', String(ops.captured)],
            ['capture_rate', `${ops.capture_rate}%`],
            ['failed', String(ops.failed)],
            ['waiting', String(ops.waiting)],
            ['pending', String(ops.pending)],
            ['partial', String(ops.partial)],
            ['partial_rate', `${ops.partial_rate}%`],
            ['recent_raw', String(ops.recent_raw)],
            ['sources', String(ops.sources)],
            ['claims', String(ops.claims)],
          ],
        ),
        '',
        table(['platform', 'total', 'captured', 'failed', 'waiting'], platformRows),
        '',
        `providers: ${Object.entries(ops.providers).map(([name, count]) => `${name} ${count}`).join(', ') || '-'}`,
        `verify_problems: ${ops.verify_problems.length ? ops.verify_problems.join(' | ') : '없음'}`,
        'suggestions:',
        ...ops.suggestions.map((suggestion) => `- ${suggestion}`),
      ].join('\n'),
    ),
    section(
      '10. Archive item re-queued with --deep',
      table(
        ['duplicate', 'promoted', 'status', 'tier', 'force_deep', 'memo'],
        [[reopened.duplicate ? 'yes' : 'no', reopened.promoted ? 'yes' : 'no', reopened.item.status, reopened.item.tier || '-', reopened.item.force_deep ? 'yes' : 'no', reopened.item.memo || '-']],
      ) + '\n\nprocess was not run again, so this item has no new notes yet.',
    ),
    section(
      '11. PDF text shaping',
      [pdfLines('pipeline paper (arxiv id title, trailing-period DOI)', shaped), pdfLines('empty scan', emptyPdf), pdfLines('info title kept', keptTitle), pdfLines('boilerplate lines skipped', skippedTitle)].join('\n\n'),
    ),
    section(
      '12. Conversation note',
      [
        `propose: ${proposed.status} id=conv-<id> duplicates=${(proposed.possible_duplicates || []).length} sources=${proposed.source_count}`,
        `again: ${duplicate.status} same=${duplicate.id === proposed.id ? 'yes' : 'no'}`,
        `review: ${approved.status} index_refresh_required=${approved.index_refresh_required ? 'yes' : 'no'}`,
        `path: ${notePath.replace(/-[0-9a-f]{8}\.md$/, '-<id8>.md')}`,
        'search before reindex: (no hits)',
        `search after reindex: ${afterIndex.map((hit) => `${hit.type} ${hit.path.replace(/-[0-9a-f]{8}\.md$/, '-<id8>.md')}`).join(', ')}`,
        '',
        noteBody.trimEnd(),
      ].join('\n'),
    ),
  ].join('\n');

  expect(report).toMatchInlineSnapshot(`
    "# Processing paths

    clock: 2026-10-26T08:00:00.000Z
    LLM replies are fixture JSON passed through parseJson. Embeddings are off. pdftotext is not executed; PDF text is shaped by pdfExtractFromText and stored with commitCapture.

    ## 1. URL intake

    | input | normalized | platform | duplicate | promoted | status | tier | force_deep | memo | id |
    | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
    | https://mobile.twitter.com/alice/status/1?s=20&t=99 | https://x.com/alice/status/1 | x | no | no | queued | - | no | - | 20261026-x-b05e93ac |
    | https://www.linkedin.com/posts/a?trk=public | https://linkedin.com/posts/a | linkedin | no | no | queued | - | no | - | 20261026-linkedin-99b3ff6b |
    | https://www.threads.net/@u/post/1 | https://threads.net/@u/post/1 | threads | no | no | queued | - | no | - | 20261026-threads-f7fc0767 |
    | https://example.com/a/b.PDF?utm_source=x | https://example.com/a/b.PDF | pdf | no | no | queued | - | no | - | 20261026-pdf-8e4d02f8 |
    | https://notlinkedin.com/jobs | https://notlinkedin.com/jobs | web | no | no | queued | - | no | - | 20261026-web-31dae6e2 |
    | https://mytwitter.com/i/status/1 | https://mytwitter.com/i/status/1 | web | no | no | queued | - | no | - | 20261026-web-d2888798 |
    | https://news.ycombinator.com/item?id=1 | https://news.ycombinator.com/item?id=1 | web | no | no | queued | - | no | - | 20261026-web-6dd66cdf |
    | https://youtu.be/abc?t=120 | https://youtu.be/abc | web | no | no | queued | - | no | - | 20261026-web-c587c1a3 |
    | https://m.wikipedia.org/wiki/Seoul | https://wikipedia.org/wiki/Seoul | web | no | no | queued | - | no | - | 20261026-web-66aa9aad |
    | https://mobile.twitter.com/alice/status/1?s=20&t=99 | https://x.com/alice/status/1 | x | yes | no | queued | - | no | - | 20261026-x-b05e93ac |
    | https://mobile.twitter.com/alice/status/1?s=20&t=99 | https://x.com/alice/status/1 | x | yes | yes | queued | deep | yes | 다시 깊게 | 20261026-x-b05e93ac |

    ## 2. Promote when there is no raw file

    missing id → null

    | case | status | tier | waiting_stage | attempts | error |
    | --- | --- | --- | --- | --- | --- |
    | missing id | - | - | - | - | - |
    | queued, no raw | queued | deep | - | 0 | - |
    | failed, no raw | queued | deep | - | 0 | - |
    | waiting for login, no raw | waiting | deep | queued | 0 | login |

    ## 3. LLM calls

    | # | stage | title |
    | --- | --- | --- |
    | 1 | triage | Evaluation Failures in Practice |
    | 2 | reduce | Evaluation Failures in Practice |
    | 3 | triage | 배포 체크리스트 |
    | 4 | reduce | 배포 체크리스트 |
    | 5 | reduce | 짧은 글 |
    | 6 | triage | 실패 유형이 먼저다 |
    | 7 | reduce | 실패 유형이 먼저다 |
    | 8 | triage | 클리퍼 체크리스트 |
    | 9 | reduce | 클리퍼 체크리스트 |
    | 10 | reflect | 4 claims, 2 refs |

    ## 4. Queue after distill

    | id | status | tier | force_deep | platform | raw | title |
    | --- | --- | --- | --- | --- | --- | --- |
    | 20261026-pdf-24424bed | done | deep | no | pdf | raw/2026/10/20261026-pdf-24424bed.raw.md | Evaluation Failures in Practice |
    | 20261026-web-2d4e16df | done | light | no | web | raw/2026/10/20261026-web-2d4e16df.raw.md | 배포 체크리스트 |
    | 20261026-web-64452683 | done | archive | no | web | raw/2026/10/20261026-web-64452683.raw.md | 홍보 |
    | 20261026-web-d45c4598 | done | deep | yes | web | raw/2026/10/20261026-web-d45c4598.raw.md | 짧은 글 |
    | 20261026-web-dfb4a73e | done | deep | no | web | raw/2026/10/20261026-web-dfb4a73e.raw.md | 실패 유형이 먼저다 |
    | 20261026-web-e8b7a281 | done | light | no | web | raw/2026/10/20261026-web-e8b7a281.raw.md | 클리퍼 체크리스트 |

    ## 5. Documents

    ### notes/LLM 평가는 정답률보다 실패 유형 분류가 먼저다.md

    ---
    type: claim
    title: LLM 평가는 정답률보다 실패 유형 분류가 먼저다
    sources:
      - 20261026-web-dfb4a73e
    tags:
      - llm-평가
      - 원자-노트
      - rubric-design
      - extra-one
      - extra-two
      - extra-three
    created: 2026-10-26T08:00:00.000Z
    processed_by: fixture
    reflected: true
    topics:
      - LLM 평가
    ---

    # LLM 평가는 정답률보다 실패 유형 분류가 먼저다

    정확도 하나는 실패가 바뀐 회귀를 숨긴다. 점수를 내기 전에 실패 유형을 적어야 다음 실행과 비교할 수 있다.

    ## 관련
    - [[정답률만으로는 회귀를 구분할 수 없다]]

    ---
    출처: [[20261026-web-dfb4a73e|실패 유형이 먼저다]]

    ### notes/sources/20261026-pdf-24424bed.md

    ---
    type: source
    id: 20261026-pdf-24424bed
    title: 실무에서의 평가 실패
    source: https://example.com/papers/evaluation-failures.pdf
    platform: pdf
    captured: 2026-10-26T08:00:00.000Z
    tier: deep
    tags:
      - llm-평가
      - pdf
    raw: raw/2026/10/20261026-pdf-24424bed.raw.md
    claims:
      - 정답률만으로는 회귀를 구분할 수 없다
    processed_by: fixture
    reflected: true
    ---

    # 실무에서의 평가 실패

    ## 요약
    - 정답률만 보면 회귀가 숨는다.
    - 표 2는 점수 대신 실패 구성의 변화를 보여 준다.
    - 부호는 원문과 대조해야 한다.

    ## 왜 저장했나
    수치를 원문과 대조하려고 (추정)

    ## 핵심 인용
    > Accuracy alone hid the regression.

    — 정답률만 보면 회귀가 숨는다.

    ## 원자 노트
    - [[정답률만으로는 회귀를 구분할 수 없다]]

    ## 원문
    - [[20261026-pdf-24424bed.raw|원문 보기]] · https://example.com/papers/evaluation-failures.pdf

    ### notes/sources/20261026-web-2d4e16df.md

    ---
    type: source
    id: 20261026-web-2d4e16df
    title: 배포 체크리스트
    source: https://example.com/articles/deploy-checklist
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    tier: light
    tags:
      - 체크리스트
      - 배포
    raw: raw/2026/10/20261026-web-2d4e16df.raw.md
    processed_by: fixture
    reflected: true
    topics:
      - LLM 평가
    ---

    # 배포 체크리스트

    ## 요약
    - 배포 전에 실패 유형을 적는다.
    - 점수판이 그대로여도 구성이 바뀌었는지 본다.
    - 체크리스트로만 보관한다.

    ## 왜 저장했나
    배포 전 점검 목록 (추정)

    ## 핵심 인용
    > Write the failure mode before the score.

    — 점수보다 먼저 실패 유형을 적는다.

    ## 원문
    - [[20261026-web-2d4e16df.raw|원문 보기]] · https://example.com/articles/deploy-checklist

    ### notes/sources/20261026-web-d45c4598.md

    ---
    type: source
    id: 20261026-web-d45c4598
    title: 짧은 글
    source: https://example.com/notes/forced-deep
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    tier: deep
    tags:
      - 강제-심층
    raw: raw/2026/10/20261026-web-d45c4598.raw.md
    claims:
      - 짧은 글도 깊게 지정하면 원자 노트가 된다
    processed_by: fixture
    reflected: true
    ---

    # 짧은 글

    ## 요약
    - 사용자가 깊게를 지정한 짧은 글이다.
    - 분량 규칙보다 그 지정이 우선한다.
    - 주장은 하나면 된다.

    ## 왜 저장했나
    규칙보다 우선 (사용자 메모)

    ## 원자 노트
    - [[짧은 글도 깊게 지정하면 원자 노트가 된다]]

    ## 원문
    - [[20261026-web-d45c4598.raw|원문 보기]] · https://example.com/notes/forced-deep

    ### notes/sources/20261026-web-dfb4a73e.md

    ---
    type: source
    id: 20261026-web-dfb4a73e
    title: 실패 유형이 먼저다
    source: https://example.com/articles/failure-modes
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    tier: deep
    tags:
      - llm-평가
      - 원자-노트
      - rubric-design
      - extra-one
      - extra-two
      - extra-three
    raw: raw/2026/10/20261026-web-dfb4a73e.raw.md
    claims:
      - LLM 평가는 정답률보다 실패 유형 분류가 먼저다
      - 채점 기준 공개가 먼저다
    processed_by: fixture
    reflected: true
    ---

    # 실패 유형이 먼저다

    ## 요약
    - 정답률보다 실패 유형을 먼저 나눈다.
    - 채점 기준은 공개되어야 나중에 비교할 수 있다.
    - 한 글에서 주장 두 개만 떼어 낸다.

    ## 왜 저장했나
    평가 기준을 다시 쓰려고 (사용자 메모)

    ## 핵심 인용
    > Score the failure,
    > not only the final answer.

    — 최종 답만이 아니라 실패를 채점한다.

    ## 원자 노트
    - [[LLM 평가는 정답률보다 실패 유형 분류가 먼저다]]
    - [[채점 기준 공개가 먼저다]]

    ## 원문
    - [[20261026-web-dfb4a73e.raw|원문 보기]] · https://example.com/articles/failure-modes

    ### notes/sources/20261026-web-e8b7a281.md

    ---
    type: source
    id: 20261026-web-e8b7a281
    title: 클리퍼 체크리스트
    source: https://www.example.com/glossary?utm_source=clip
    platform: web
    author: Ada Lovelace
    published: 2026-08-01
    captured: 2026-10-26T08:00:00.000Z
    tier: light
    tags:
      - 용어
      - 클리퍼
    raw: raw/2026/10/20261026-web-e8b7a281.raw.md
    processed_by: fixture
    reflected: true
    topics:
      - LLM 평가
    ---

    # 클리퍼 체크리스트

    ## 요약
    - 용어는 한국어를 먼저 쓰고 영어를 괄호에 둔다.
    - 클리퍼 파일은 브라우저 추출이 아니다.
    - 참고만 하고 원자 노트는 만들지 않는다.

    ## 왜 저장했나
    표기를 맞춰 두려고 (추정)

    ## 핵심 인용
    > Write the failure mode before the score.

    — 점수보다 먼저 실패 유형을 적는다.

    ## 원문
    - [[20261026-web-e8b7a281.raw|원문 보기]] · https://www.example.com/glossary?utm_source=clip

    ### notes/정답률만으로는 회귀를 구분할 수 없다.md

    ---
    type: claim
    title: 정답률만으로는 회귀를 구분할 수 없다
    sources:
      - 20261026-pdf-24424bed
    tags:
      - llm-평가
      - pdf
    created: 2026-10-26T08:00:00.000Z
    processed_by: fixture
    reflected: true
    verify: 수치 원문 대조 필요
    topics:
      - LLM 평가
    ---

    # 정답률만으로는 회귀를 구분할 수 없다

    > ⚠️ 수치·표 값은 PDF 추출본 기준입니다. 인용 전 원본 PDF와 대조하세요.

    표 2에서 정답률은 유지됐고 실패 유형의 구성만 바뀌었다 (p.2). 증감의 부호는 원본 PDF와 대조해야 한다.

    ## 관련
    - [[LLM 평가는 정답률보다 실패 유형 분류가 먼저다]]

    ---
    출처: [[20261026-pdf-24424bed|실무에서의 평가 실패]]

    ### notes/짧은 글도 깊게 지정하면 원자 노트가 된다.md

    ---
    type: claim
    title: 짧은 글도 깊게 지정하면 원자 노트가 된다
    sources:
      - 20261026-web-d45c4598
    tags:
      - 강제-심층
    created: 2026-10-26T08:00:00.000Z
    processed_by: fixture
    reflected: true
    topics:
      - LLM 평가
    ---

    # 짧은 글도 깊게 지정하면 원자 노트가 된다

    본문이 짧아도 사용자가 깊게를 지정하면 보관만이 되지 않는다. 이 노트는 그 분기를 남긴다.

    ---
    출처: [[20261026-web-d45c4598|짧은 글]]

    ### notes/채점 기준 공개가 먼저다.md

    ---
    type: claim
    title: "채점 기준: 공개가 먼저다"
    sources:
      - 20261026-web-dfb4a73e
    tags:
      - llm-평가
      - 원자-노트
      - rubric-design
      - extra-one
      - extra-two
      - extra-three
    created: 2026-10-26T08:00:00.000Z
    processed_by: fixture
    reflected: true
    topics:
      - LLM 평가
    ---

    # 채점 기준: 공개가 먼저다

    기준이 공개되지 않으면 두 실행의 점수 차이를 해석할 수 없다. 기준은 결과 숫자와 따로 보관한다.

    ---
    출처: [[20261026-web-dfb4a73e|실패 유형이 먼저다]]

    ### raw/2026/10/20261026-pdf-24424bed.raw.md

    ---
    type: raw
    id: 20261026-pdf-24424bed
    title: Evaluation Failures in Practice
    source: https://example.com/papers/evaluation-failures.pdf
    platform: pdf
    captured: 2026-10-26T08:00:00.000Z
    word_count: 105
    extractor: pdftotext
    extract_log:
      tool: pdftotext
      version: poppler-fixture
      args: -enc UTF-8
      at: 2026-10-26T08:00:00.000Z
      pages: "3"
    doi: 10.1145/3290605.3300233
    quality: complete
    ---

    # Evaluation Failures in Practice

    <!-- p.1 -->

    Evaluation Failures in Practice

    Accuracy alone hid the regression in the May release.
    Table 2 keeps the headline score flat while the failure mix moves.
    The sign of each delta is the part a reader must check against the original.
    doi: 10.1145/3290605.3300233.


    <!-- p.2 -->


    The second page repeats the warning and adds a short method note for the archive rule.
    We counted these words so triage does not file the paper as a short text.
    Trailing spaces should disappear from the stored line.


    <!-- p.3 -->


    Appendix starts here with another sentence so the page count includes a third page marker.

    ### raw/2026/10/20261026-web-2d4e16df.raw.md

    ---
    type: raw
    id: 20261026-web-2d4e16df
    title: 배포 체크리스트
    source: https://example.com/articles/deploy-checklist
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    site: Ada Lovelace
    language: en
    word_count: 49
    extractor: defuddle:generic
    quality: complete
    ---

    # 배포 체크리스트

    Write the failure mode before the score. Check that the rubric is attached. Do not treat a flat accuracy line as proof that nothing changed. Keep this as a checklist rather than a claim. The paragraph is long enough to avoid the archive rule and the partial save rule.

    ### raw/2026/10/20261026-web-64452683.raw.md

    ---
    type: raw
    id: 20261026-web-64452683
    title: 홍보
    source: https://example.com/ads/launch
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    site: Ada Lovelace
    language: en
    word_count: 16
    extractor: defuddle:generic
    quality: complete
    ---

    # 홍보

    Limited offer today only buy now free gift click here fast ends soon extra deal wow

    ### raw/2026/10/20261026-web-d45c4598.raw.md

    ---
    type: raw
    id: 20261026-web-d45c4598
    title: 짧은 글
    source: https://example.com/notes/forced-deep
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    site: Ada Lovelace
    language: en
    word_count: 17
    extractor: defuddle:generic
    quality: complete
    memo: 규칙보다 우선
    ---

    # 짧은 글

    Keep this short on purpose so the archive rule would fire without the force deep flag set

    ### raw/2026/10/20261026-web-dfb4a73e.raw.md

    ---
    type: raw
    id: 20261026-web-dfb4a73e
    title: 실패 유형이 먼저다
    source: https://example.com/articles/failure-modes
    platform: web
    author: Ada Lovelace
    published: 2026-09-01
    captured: 2026-10-26T08:00:00.000Z
    site: Ada Lovelace
    language: en
    word_count: 66
    extractor: defuddle:generic
    quality: complete
    memo: 평가 기준을 다시 쓰려고
    ---

    # 실패 유형이 먼저다

    Score the failure, not only the final answer. A single accuracy number hides a regression when the model fails in a new way. Teams should label the failure mode before they publish a score. The rubric has to be public so a later reader can compare two runs. This paragraph is long enough to pass the short text archive rule and to stay a complete capture.

    ### raw/2026/10/20261026-web-e8b7a281.raw.md

    ---
    type: raw
    id: 20261026-web-e8b7a281
    title: 클리퍼 체크리스트
    source: https://www.example.com/glossary?utm_source=clip
    platform: web
    author: Ada Lovelace
    published: 2026-08-01
    captured: 2026-10-26T08:00:00.000Z
    description: 수동으로 저장한 용어 메모
    word_count: 53
    extractor: obsidian-web-clipper
    quality: complete
    ---

    # 클리퍼 체크리스트

    Write the term in Korean first and keep the English in parentheses. This file is the manual Web Clipper path, not a browser render. The body has enough words to stay out of the archive rule and the partial rule. Glossary entries are reference material, so this one stays light.

    ### topics/LLM 평가.md

    ---
    type: topic
    title: LLM 평가
    description: 실패 유형을 먼저 보는 평가
    created: 2026-10-26T08:00:00.000Z
    updated: 2026-10-26T08:00:00.000Z
    notes_count: 4
    refs_count: 2
    ---

    # LLM 평가

    ## 개요
    [[LLM 평가는 정답률보다 실패 유형 분류가 먼저다]]가 정답률보다 실패 유형을 먼저 보라고 말한다. [[정답률만으로는 회귀를 구분할 수 없다#기준]]는 채점 기준의 공개를 다룬다. 없는 노트는 지운다. 빠진 절도 지운다.

    ## 노트
    - [[LLM 평가는 정답률보다 실패 유형 분류가 먼저다]] — 이 주장을 주제 지도에 둔다
    - [[정답률만으로는 회귀를 구분할 수 없다]] — 이 주장을 주제 지도에 둔다
    - [[짧은 글도 깊게 지정하면 원자 노트가 된다]] — 이 주장을 주제 지도에 둔다
    - [[채점 기준 공개가 먼저다]] — 이 주장을 주제 지도에 둔다

    ## 참고 자료
    - [[20261026-web-2d4e16df|배포 체크리스트]] — 가볍게 저장한 참고
    - [[20261026-web-e8b7a281|클리퍼 체크리스트]] — 가볍게 저장한 참고

    ## 6. Verify

    문제 없음

    ## 7. Search

    query: failure
    | # | type | title | snippet | path |
    | --- | --- | --- | --- | --- |
    | 1 | raw | Evaluation Failures in Practice | # Evaluation Failures in Practice <!-- p.1 --> Evaluation Failures in Practice Accuracy al | raw/2026/10/20261026-pdf-24424bed.raw.md |
    | 2 | source | 실패 유형이 먼저다 | …낸다. ## 왜 저장했나 평가 기준을 다시 쓰려고 (사용자 메모) ## 핵심 인용 > Score the failure, > not only the final a | notes/sources/20261026-web-dfb4a73e.md |
    | 3 | raw | 실패 유형이 먼저다 | # 실패 유형이 먼저다 Score the failure, not only the final answer. A single accuracy number hides  | raw/2026/10/20261026-web-dfb4a73e.raw.md |
    | 4 | source | 배포 체크리스트 | …스트로만 보관한다. ## 왜 저장했나 배포 전 점검 목록 (추정) ## 핵심 인용 > Write the failure mode before the score.  | notes/sources/20261026-web-2d4e16df.md |
    | 5 | raw | 배포 체크리스트 | # 배포 체크리스트 Write the failure mode before the score. Check that the rubric is attached. Do  | raw/2026/10/20261026-web-2d4e16df.raw.md |

    query: 실패 유형
    | # | type | title | snippet | path |
    | --- | --- | --- | --- | --- |
    | 1 | claim | LLM 평가는 정답률보다 실패 유형 분류가 먼저다 | # LLM 평가는 정답률보다 실패 유형 분류가 먼저다 정확도 하나는 실패가 바뀐 회귀를 숨긴다. 점수를 내기 전에 실패 유형을 적어야 다음 실행과 비교할 수 있다 | notes/LLM 평가는 정답률보다 실패 유형 분류가 먼저다.md |
    | 2 | source | 실패 유형이 먼저다 | # 실패 유형이 먼저다 ## 요약 - 정답률보다 실패 유형을 먼저 나눈다. - 채점 기준은 공개되어야 나중에 비교할 수 있다. - 한 글에서 주장 두 개만 떼어  | notes/sources/20261026-web-dfb4a73e.md |
    | 3 | raw | 실패 유형이 먼저다 | # 실패 유형이 먼저다 Score the failure, not only the final answer. A single accuracy number hides  | raw/2026/10/20261026-web-dfb4a73e.raw.md |
    | 4 | source | 배포 체크리스트 | # 배포 체크리스트 ## 요약 - 배포 전에 실패 유형을 적는다. - 점수판이 그대로여도 구성이 바뀌었는지 본다. - 체크리스트로만 보관한다. ## 왜 저장했나  | notes/sources/20261026-web-2d4e16df.md |
    | 5 | source | 클리퍼 체크리스트 | …핵심 인용 > Write the failure mode before the score. — 점수보다 먼저 실패 유형을 적는다. ## 원문 - [[20261026 | notes/sources/20261026-web-e8b7a281.md |

    query: 체크리스트
    | # | type | title | snippet | path |
    | --- | --- | --- | --- | --- |
    | 1 | source | 배포 체크리스트 | # 배포 체크리스트 ## 요약 - 배포 전에 실패 유형을 적는다. - 점수판이 그대로여도 구성이 바뀌었는지 본다. - 체크리스트로만 보관한다. ## 왜 저장했나  | notes/sources/20261026-web-2d4e16df.md |
    | 2 | raw | 배포 체크리스트 | # 배포 체크리스트 Write the failure mode before the score. Check that the rubric is attached. Do  | raw/2026/10/20261026-web-2d4e16df.raw.md |
    | 3 | raw | 클리퍼 체크리스트 | # 클리퍼 체크리스트 Write the term in Korean first and keep the English in parentheses. This file  | raw/2026/10/20261026-web-e8b7a281.raw.md |
    | 4 | source | 클리퍼 체크리스트 | # 클리퍼 체크리스트 ## 요약 - 용어는 한국어를 먼저 쓰고 영어를 괄호에 둔다. - 클리퍼 파일은 브라우저 추출이 아니다. - 참고만 하고 원자 노트는 만들지 | notes/sources/20261026-web-e8b7a281.md |
    | 5 | topic | LLM 평가 | …]] — 이 주장을 주제 지도에 둔다 ## 참고 자료 - [[20261026-web-2d4e16df\\|배포 체크리스트]] — 가볍게 저장한 참고 - [[20261 | topics/LLM 평가.md |

    query: LLM  types: claim
    | # | type | title | snippet | path |
    | --- | --- | --- | --- | --- |
    | 1 | claim | LLM 평가는 정답률보다 실패 유형 분류가 먼저다 | # LLM 평가는 정답률보다 실패 유형 분류가 먼저다 정확도 하나는 실패가 바뀐 회귀를 숨긴다. 점수를 내기 전에 실패 유형을 적어야 다음 실행과 비교할 수 있다 | notes/LLM 평가는 정답률보다 실패 유형 분류가 먼저다.md |
    | 2 | claim | 정답률만으로는 회귀를 구분할 수 없다 | … 실패 유형의 구성만 바뀌었다 (p.2). 증감의 부호는 원본 PDF와 대조해야 한다. ## 관련 - [[LLM 평가는 정답률보다 실패 유형 분류가 먼저다]]  | notes/정답률만으로는 회귀를 구분할 수 없다.md |

    query: of
    | # | type | title | snippet | path |
    | --- | --- | --- | --- | --- |
    | 1 | raw | Evaluation Failures in Practice | …e headline score flat while the failure mix moves. The sign of each delta is the part a r | raw/2026/10/20261026-pdf-24424bed.raw.md |
    | 2 | raw | 배포 체크리스트 | …rubric is attached. Do not treat a flat accuracy line as proof that nothing changed. Keep | raw/2026/10/20261026-web-2d4e16df.raw.md |
    | 3 | raw | 홍보 | # 홍보 Limited offer today only buy now free gift click here fast ends soon extra deal wow | raw/2026/10/20261026-web-64452683.raw.md |
    | 4 | raw | 클리퍼 체크리스트 | …not a browser render. The body has enough words to stay out of the archive rule and the p | raw/2026/10/20261026-web-e8b7a281.raw.md |

    backlinks of notes/LLM 평가는 정답률보다 실패 유형 분류가 먼저다.md
    | type | title | path |
    | --- | --- | --- |
    | claim | 정답률만으로는 회귀를 구분할 수 없다 | notes/정답률만으로는 회귀를 구분할 수 없다.md |
    | source | 실패 유형이 먼저다 | notes/sources/20261026-web-dfb4a73e.md |
    | topic | LLM 평가 | topics/LLM 평가.md |

    ## 8. Index stats

    | type | count |
    | --- | --- |
    | claim | 4 |
    | note | 4 |
    | raw | 6 |
    | source | 5 |
    | topic | 1 |

    built_at: 2026-10-26T08:00:00.000Z

    ## 9. Ops (3 days)

    | metric | value |
    | --- | --- |
    | generated_at | 2026-10-26T08:00:00.000Z |
    | total | 6 |
    | attempted | 6 |
    | captured | 6 |
    | capture_rate | 100% |
    | failed | 0 |
    | waiting | 0 |
    | pending | 0 |
    | partial | 0 |
    | partial_rate | 0% |
    | recent_raw | 6 |
    | sources | 5 |
    | claims | 4 |

    | platform | total | captured | failed | waiting |
    | --- | --- | --- | --- | --- |
    | pdf | 1 | 1 | 0 | 0 |
    | web | 5 | 5 | 0 | 0 |

    providers: fixture 5
    verify_problems: 없음
    suggestions:
    - 최근 운영 지표에서 즉시 조치가 필요한 이상 징후가 없습니다.

    ## 10. Archive item re-queued with --deep

    | duplicate | promoted | status | tier | force_deep | memo |
    | --- | --- | --- | --- | --- | --- |
    | yes | yes | triaged | deep | yes | 보관만이었던 글을 깊게 |

    process was not run again, so this item has no new notes yet.

    ## 11. PDF text shaping

    ### pipeline paper (arxiv id title, trailing-period DOI)
    - title: Evaluation Failures in Practice
    - extractor: pdftotext
    - words: 105
    - doi: 10.1145/3290605.3300233
    - pages: 3
    - args: -enc UTF-8
    - at: 2026-10-26T08:00:00.000Z

    <!-- p.1 -->

    Evaluation Failures in Practice

    Accuracy alone hid the regression in the May release.
    Table 2 keeps the headline score flat while the failure mix moves.
    The sign of each delta is the part a reader must check against the original.
    doi: 10.1145/3290605.3300233.


    <!-- p.2 -->


    The second page repeats the warning and adds a short method note for the archive rule.
    We counted these words so triage does not file the paper as a short text.
    Trailing spaces should disappear from the stored line.


    <!-- p.3 -->


    Appendix starts here with another sentence so the page count includes a third page marker.

    ### empty scan
    - title: scan.pdf
    - extractor: pdftotext:empty(스캔 PDF 가능성)
    - words: 3
    - doi: -
    - pages: 1
    - args: -enc UTF-8
    - at: 2026-10-26T08:00:00.000Z

    <!-- p.1 -->

    ### info title kept
    - title: Methods That Survive Contact
    - extractor: pdftotext:empty(스캔 PDF 가능성)
    - words: 24
    - doi: -
    - pages: 1
    - args: -enc UTF-8
    - at: 2026-10-26T08:00:00.000Z

    <!-- p.1 -->

    Proceedings of the Conference

    This line would have been the title if the info title were missing or an arxiv id.

    ### boilerplate lines skipped
    - title: Failure Modes as the Unit of Evaluation
    - extractor: pdftotext:empty(스캔 PDF 가능성)
    - words: 20
    - doi: -
    - pages: 1
    - args: -enc UTF-8
    - at: 2026-10-26T08:00:00.000Z

    <!-- p.1 -->

    arXiv:2401.12345
    1
    Proceedings of the Conference on Stuff
    Copyright 2026
    Failure Modes as the Unit of Evaluation

    ## 12. Conversation note

    propose: pending_review id=conv-<id> duplicates=0 sources=1
    again: duplicate same=yes
    review: approved index_refresh_required=yes
    path: notes/conversations/대화에서 확정한 평가 원칙-<id8>.md
    search before reindex: (no hits)
    search after reindex: conversation notes/conversations/대화에서 확정한 평가 원칙-<id8>.md

    ---
    type: conversation
    title: 대화에서 확정한 평가 원칙
    project: info-processing
    kind: decision
    created: 2026-10-26T08:00:00.000Z
    approved: 2026-10-26T08:00:00.000Z
    candidate_id: conv-<id>
    conversation_ref: conversation:snapshot
    evidence:
      - https://example.com/articles/failure-modes
    ---

    # 대화에서 확정한 평가 원칙

    ## 지식
    기존 접근을 유지한다. 평가원칙토큰 은 승인 후에만 색인된다. 이 문장은 길이를 넘긴다.

    ## 근거
    - https://example.com/articles/failure-modes

    ## 추적
    - 후보 ID: conv-<id>
    - 프로젝트: info-processing
    - 원 대화 참조: conversation:snapshot
    "
  `);
});

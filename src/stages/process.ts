import fs from 'node:fs';
import path from 'node:path';
import { config, kpath } from '../config.ts';
import * as Q from '../queue.ts';
import { LimitError, ask } from '../llm/runners.ts';
import { gitCommit, gitRevert, log, now, readDoc, slugify, stringifyDoc, writeFile } from '../util.ts';
import { verifyAll } from '../verify.ts';

function selfFile(name: string) {
  const p = kpath('self', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

function rawText(item: Q.Item) {
  const d = readDoc(kpath(item.raw!));
  return { data: d.data, body: d.body.slice(0, config.limits.rawCharsForLlm) };
}

// ---------------- triage ----------------
const TIERS = ['deep', 'light', 'archive'] as const;

function triagePrompt(item: Q.Item, raw: { data: any; body: string }) {
  const profile = selfFile('interests.md') || '(아직 없음. 일반 기준: 구체적 주장·방법·데이터·사례가 있으면 가치 있음. 홍보·잡담·채용공고·짧은 감탄은 낮음)';
  return `당신은 개인 지식 저장소의 분류기입니다. 글 하나를 세 등급 중 하나로 분류합니다.
- deep: 관심사에 맞고, 재사용할 주장·방법·근거가 있는 글 (전체의 약 20%)
- light: 참고할 만하지만 핵심 주장을 따로 뽑을 정도는 아님 (약 50%)
- archive: 보관만. 알맹이가 적거나 관심사 밖 (약 30%)

관심사 프로필:
${profile}

사용자 메모: ${item.memo || '없음'}
제목: ${raw.data.title}
플랫폼: ${raw.data.platform} / 작성자: ${raw.data.author || '?'}
본문(앞부분):
${raw.body.slice(0, 3500)}

출력 스키마: {"tier": "deep"|"light"|"archive", "reason": "한국어 한 문장"}`;
}

async function triage(item: Q.Item) {
  if (item.force_deep) {
    item.tier = 'deep';
    return 'user';
  }
  const raw = rawText(item);
  if ((raw.data.word_count || 0) < 25 && !item.memo) {
    item.tier = 'archive';
    return 'rule';
  }
  const r = await ask(config.llm.triage, triagePrompt(item, raw), (v) => {
    if (!TIERS.includes(v.tier)) throw new Error('tier 값 오류');
    return v as { tier: Q.Tier; reason: string };
  });
  item.tier = r.value.tier;
  return r.provider;
}

// ---------------- reduce ----------------
type Reduced = {
  summary: string[];
  why_saved: string;
  quotes: { text: string; gloss?: string }[];
  tags: string[];
  claims: { title: string; body: string }[];
};

function reducePrompt(item: Q.Item, raw: { data: any; body: string }, deep: boolean) {
  const glossary = selfFile('glossary.md');
  return `당신은 개인 지식 저장소의 증류기입니다(arscontexta의 reduce 단계). 아래 원문에서 재사용 가능한 지식을 뽑습니다.

규칙
- 모든 출력은 한국어. 단, quotes.text는 원문 그대로(번역 금지), 영문이면 gloss에 한국어 한 줄 풀이.
- 원문에 없는 사실을 만들지 마세요. 추정은 "추정"이라고 쓰세요.
- 전문 용어는 처음 나올 때 한국어(영어) 병기. 용어집이 있으면 그 표기를 따르세요.
- summary: 3줄 이내, 각 줄 한 문장.
- why_saved: 사용자가 이 글을 저장한 이유 추정 한 문장(사용자 메모가 있으면 그것을 우선).
- tags: 소문자 한국어/영어 키워드 3~6개(예: "llm-평가", "ux-리서치").
${deep ? `- claims: 원자 노트 1~5개. 각 title은 "주장 한 문장"(예: "LLM 평가는 정답률보다 실패 유형 분류가 먼저다"), 40자 안팎, 마침표 없음. body는 2~6문장 마크다운으로 근거·맥락·한계를 설명. 글 전체 요약이 아니라 따로 떼어 써도 이해되는 하나의 생각.` : '- claims: 빈 배열 [] (이 글은 가볍게 등급)'}

용어집:
${glossary || '(없음)'}

사용자 메모: ${item.memo || '없음'}
제목: ${raw.data.title}
작성자: ${raw.data.author || '?'} / 플랫폼: ${raw.data.platform} / 게시: ${raw.data.published || '?'}
원문:
${raw.body}

출력 스키마: {"summary": [string], "why_saved": string, "quotes": [{"text": string, "gloss": string}], "tags": [string], "claims": [{"title": string, "body": string}]}`;
}

function validateReduced(deep: boolean) {
  return (v: any): Reduced => {
    if (!Array.isArray(v.summary) || !v.summary.length) throw new Error('summary 누락');
    if (!Array.isArray(v.claims)) v.claims = [];
    if (deep && !v.claims.length) throw new Error('claims 누락');
    v.claims = v.claims.filter((c: any) => c?.title && c?.body).slice(0, 5);
    v.quotes = (Array.isArray(v.quotes) ? v.quotes : []).filter((q: any) => q?.text).slice(0, 5);
    v.tags = (Array.isArray(v.tags) ? v.tags : []).map((t: any) => String(t).toLowerCase().replace(/\s+/g, '-')).slice(0, 6);
    v.why_saved = String(v.why_saved || '');
    return v;
  };
}

function uniqueNotePath(title: string) {
  const base = slugify(title) || 'untitled';
  let name = base, n = 2;
  while (fs.existsSync(kpath('notes', `${name}.md`)) || fs.existsSync(kpath('topics', `${name}.md`))) name = `${base} (${n++})`;
  return { name, file: kpath('notes', `${name}.md`) };
}

function writeReduced(item: Q.Item, raw: { data: any }, r: Reduced, provider: string): string[] {
  const claimNames: string[] = [];
  const written: string[] = [];
  for (const c of r.claims) {
    c.title = c.title.trim().replace(/[.。]+$/, '');
    const { name, file } = uniqueNotePath(c.title);
    claimNames.push(name);
    written.push(`notes/${name}.md`);
    writeFile(
      file,
      stringifyDoc(
        { type: 'claim', title: c.title, sources: [item.id], tags: r.tags, created: now(), processed_by: provider, reflected: false },
        `# ${c.title}\n\n${c.body.trim()}\n\n---\n출처: [[${item.id}|${String(raw.data.title).slice(0, 60)}]]`,
      ),
    );
  }
  const quotes = r.quotes.map((q) => `> ${q.text.replace(/\n/g, '\n> ')}${q.gloss ? `\n\n— ${q.gloss}` : ''}`).join('\n\n');
  const body = [
    `# ${raw.data.title}`,
    `## 요약\n${r.summary.map((s) => `- ${s}`).join('\n')}`,
    `## 왜 저장했나\n${item.memo ? `${item.memo} (사용자 메모)` : `${r.why_saved} (추정)`}`,
    quotes && `## 핵심 인용\n${quotes}`,
    claimNames.length && `## 원자 노트\n${claimNames.map((n) => `- [[${n}]]`).join('\n')}`,
    `## 원문\n- [[${path.basename(item.raw!, '.md')}|원문 보기]] · ${raw.data.source}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  writeFile(
    kpath('notes', 'sources', `${item.id}.md`),
    stringifyDoc(
      {
        type: 'source',
        id: item.id,
        title: raw.data.title,
        source: raw.data.source,
        platform: raw.data.platform,
        author: raw.data.author,
        published: raw.data.published,
        captured: raw.data.captured,
        tier: item.tier,
        tags: r.tags,
        raw: item.raw,
        claims: claimNames.length ? claimNames : undefined,
        processed_by: provider,
        reflected: false,
      },
      body,
    ),
  );
  written.push(`notes/sources/${item.id}.md`);
  return written;
}

export async function runProcess() {
  const items = Q.all().filter((i) => i.status === 'captured' || i.status === 'triaged' || (i.status === 'waiting' && (i.waiting_stage === 'captured' || i.waiting_stage === 'triaged')));
  if (!items.length) return 0;
  let done = 0;
  for (const item of items.slice(0, config.limits.reducePerRun)) {
    try {
      if (!item.tier || item.status === 'captured' || item.waiting_stage === 'captured') {
        const by = await triage(item);
        Object.assign(item, { status: 'triaged', waiting_stage: undefined });
        Q.save(item);
        log(`triage ${item.id} → ${item.tier} (${by})`);
      }
      if (item.tier === 'archive') {
        Object.assign(item, { status: 'done' });
        Q.save(item);
        continue;
      }
      const deep = item.tier === 'deep';
      const raw = rawText(item);
      const r = await ask(config.llm.reduce, reducePrompt(item, raw, deep), validateReduced(deep));
      const written = writeReduced(item, raw, r.value, r.provider);
      const problems = verifyAll({ only: written });
      if (problems.length) {
        gitRevert(config.knowledgeDir);
        throw new Error(`verify 실패(되돌림): ${problems.slice(0, 3).join(' / ')}`);
      }
      gitCommit(config.knowledgeDir, `reduce(${r.provider}): ${item.id} [${item.tier}] +${r.value.claims.length} notes`);
      Object.assign(item, { status: 'reduced', waiting_stage: undefined, error: undefined });
      Q.save(item);
      done++;
      log(`reduce ${item.id} → ${r.value.claims.length}개 노트 (${r.provider})`);
    } catch (e: any) {
      if (e instanceof LimitError) {
        Object.assign(item, { status: 'waiting', waiting_stage: item.status === 'waiting' ? item.waiting_stage : item.status, error: e.message });
        Q.save(item);
        log('모든 프로바이더 한도 — 다음 실행으로 미룸');
        break;
      }
      log('process 실패', item.id, e.message);
      Object.assign(item, { status: 'failed', error: e.message });
      Q.save(item);
    }
  }
  return done;
}

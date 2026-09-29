import fs from 'node:fs';
import path from 'node:path';
import { config, kpath } from '../config.ts';
import * as Q from '../queue.ts';
import { LimitError, ask } from '../llm/runners.ts';
import { gitCommit, gitRevert, log, now, readDoc, slugify, stringifyDoc, walk, writeFile } from '../util.ts';
import { verifyAll } from '../verify.ts';

type Note = { name: string; rel: string; data: any; body: string };

const load = (dir: string): Note[] =>
  walk(kpath(dir)).map((f) => {
    const d = readDoc(f);
    return { name: path.basename(f, '.md'), rel: path.relative(config.knowledgeDir, f), data: d.data, body: d.body };
  });

type TopicOut = { title: string; description?: string; overview?: string; notes?: { note: string; line: string }[]; refs?: { source: string; line: string }[] };
type ReflectOut = { topics: TopicOut[]; related: { note: string; related: string[] }[] };

function prompt(claims: Note[], lights: Note[], topics: Note[], older: Note[]) {
  const excerpt = (n: Note, k = 500) => n.body.replace(/^# .*\n/, '').replace(/\n---\n출처:.*$/s, '').trim().slice(0, k);
  return `당신은 개인 지식 저장소의 편집자입니다(arscontexta의 reflect + reweave 단계).
새 원자 노트와 참고 자료를 기존 주제 지도(MOC)에 엮고, 새 노트와 기존 노트 사이의 관련 링크를 제안합니다.

규칙
- 한국어로 씁니다.
- 새 노트는 모두 최소 1개 주제에 넣습니다. 기존 주제가 맞으면 **그 title을 정확히 그대로** 씁니다.
- 새 주제는 새 노트 2개 이상이 뒷받침할 때만 만듭니다. 주제 title은 짧은 명사구(예: "LLM 평가 방법").
- 한 번에 새 주제는 최대 5개.
- notes[].note / refs[].source / related 값은 아래 목록의 이름을 **정확히** 복사합니다. 없는 이름을 만들지 마세요.
- line: 그 노트가 이 주제에서 갖는 의미 한 줄(20~60자).
- overview: 주제의 현재 이해를 2~5문장으로. 문장마다 근거 노트를 [[노트 이름]]으로 인용. 기존 주제를 갱신할 때는 새 노트가 바꾼 점을 반영한 전체 개요를 다시 씁니다.
- related: 새 노트마다 의미상 가까운 기존 노트(아래 "기존 노트")를 0~3개. 억지로 채우지 마세요.

## 새 원자 노트
${claims.map((n) => `### ${n.name}\n태그: ${(n.data.tags || []).join(', ')}\n${excerpt(n)}`).join('\n\n') || '(없음)'}

## 새 참고 자료(가볍게 등급 출처 노트)
${lights.map((n) => `- ${n.name} | ${n.data.title} | 태그: ${(n.data.tags || []).join(', ')} | ${excerpt(n, 200).replace(/\n/g, ' ')}`).join('\n') || '(없음)'}

## 기존 주제 지도
${topics.map((t) => `- ${t.data.title}: ${t.data.description || ''} (노트 ${t.data.notes_count || 0}개)`).join('\n') || '(아직 없음)'}

## 기존 노트(관련 링크 후보)
${older.map((n) => `- ${n.name}`).join('\n') || '(없음)'}

출력 스키마:
{"topics": [{"title": string, "description": string, "overview": string, "notes": [{"note": string, "line": string}], "refs": [{"source": string, "line": string}]}],
 "related": [{"note": string, "related": [string]}]}`;
}

function section(body: string, heading: string): string[] {
  const m = body.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1].split('\n').filter((l) => l.trim().startsWith('- ')) : [];
}

function renderTopic(title: string, overview: string, notes: string[], refs: string[]) {
  return [`# ${title}`, `## 개요\n${overview.trim()}`, `## 노트\n${notes.join('\n')}`, refs.length ? `## 참고 자료\n${refs.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

const linkName = (line: string) => line.match(/\[\[([^\]|#]+)/)?.[1];

function stripBadLinks(text: string, valid: Set<string>) {
  return text.replace(/\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]/g, (all, n, alias) => (valid.has(n.trim()) ? all : alias || n));
}

export async function runReflect() {
  const allNotes = load('notes').filter((n) => !n.rel.startsWith('notes/sources/'));
  const sources = load('notes/sources');
  const claims = allNotes.filter((n) => n.data.type === 'claim' && n.data.reflected === false).slice(0, config.limits.reflectNotesPerRun);
  const lights = sources.filter((n) => n.data.tier === 'light' && n.data.reflected === false).slice(0, config.limits.reflectNotesPerRun);
  if (!claims.length && !lights.length) return 0;
  const topics = load('topics');
  const pendingNames = new Set(claims.map((c) => c.name));
  const older = allNotes.filter((n) => n.data.type === 'claim' && !pendingNames.has(n.name)).slice(-300);
  log(`reflect: 노트 ${claims.length} · 참고 ${lights.length} · 기존 주제 ${topics.length}`);

  const validNotes = new Set(allNotes.map((n) => n.name));
  const validSources = new Set(lights.map((n) => n.name));
  let r;
  try {
    r = await ask<ReflectOut>(config.llm.reflect, prompt(claims, lights, topics, older), (v) => {
      if (!Array.isArray(v.topics)) throw new Error('topics 누락');
      v.related = Array.isArray(v.related) ? v.related : [];
      return v;
    });
  } catch (e) {
    if (e instanceof LimitError) {
      log('reflect: Claude 한도 — 다음 실행으로 미룸');
      return 0;
    }
    throw e;
  }

  const written: string[] = [];
  const byTitle = new Map(topics.map((t) => [String(t.data.title), t]));
  const assigned = new Map<string, string[]>();
  let created = 0;
  for (const t of r.value.topics.filter((t) => t?.title)) {
    const existing = byTitle.get(t.title);
    if (!existing && created >= 5) continue;
    const notes = (t.notes || []).filter((n) => validNotes.has(n.note));
    const refs = (t.refs || []).filter((n) => validSources.has(n.source));
    if (!existing && notes.length + refs.length < 2) continue;
    const name = existing?.name || slugify(t.title);
    const noteLines = existing ? section(existing.body, '노트') : [];
    const refLines = existing ? section(existing.body, '참고 자료') : [];
    const have = new Set([...noteLines, ...refLines].map(linkName));
    for (const n of notes) if (!have.has(n.note)) (noteLines.push(`- [[${n.note}]] — ${n.line}`), have.add(n.note));
    for (const s of refs) {
      if (have.has(s.source)) continue;
      const title = sources.find((x) => x.name === s.source)?.data.title || s.source;
      refLines.push(`- [[${s.source}|${String(title).slice(0, 60)}]] — ${s.line}`);
      have.add(s.source);
    }
    for (const n of notes) assigned.set(n.note, [...(assigned.get(n.note) || []), name]);
    for (const s of refs) assigned.set(s.source, [...(assigned.get(s.source) || []), name]);
    const oldOverview = existing?.body.match(/## 개요\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
    const overview = stripBadLinks(t.overview || oldOverview, validNotes);
    const data = {
      type: 'topic',
      title: t.title,
      description: t.description || existing?.data.description,
      created: existing?.data.created || now(),
      updated: now(),
      notes_count: noteLines.length,
      refs_count: refLines.length,
    };
    writeFile(kpath('topics', `${name}.md`), stringifyDoc(data, renderTopic(t.title, overview, noteLines, refLines)));
    written.push(`topics/${name}.md`);
    if (!existing) created++;
  }

  // reweave: 관련 링크를 양방향으로 추가(한 번에 기존 노트 최대 N개 수정)
  const noteByName = new Map(allNotes.map((n) => [n.name, n]));
  const touched = new Set<string>();
  const addRelated = (n: Note, other: string) => {
    const lines = section(n.body, '관련');
    if (lines.some((l) => linkName(l) === other)) return;
    const item = `- [[${other}]]`;
    if (lines.length) n.body = n.body.replace(/## 관련\n/, `## 관련\n${item}\n`);
    else if (n.body.includes('\n---\n출처:')) n.body = n.body.replace('\n---\n출처:', `\n## 관련\n${item}\n\n---\n출처:`);
    else n.body = `${n.body.trim()}\n\n## 관련\n${item}\n`;
  };
  for (const rel of r.value.related) {
    const a = noteByName.get(rel.note);
    if (!a || !pendingNames.has(a.name)) continue;
    for (const o of (rel.related || []).slice(0, 3)) {
      const b = noteByName.get(o);
      if (!b || b.name === a.name) continue;
      if (!pendingNames.has(b.name) && !touched.has(b.name) && touched.size >= config.limits.reweavePerRun) continue;
      addRelated(a, b.name);
      addRelated(b, a.name);
      touched.add(a.name);
      touched.add(b.name);
    }
  }

  // 반영 표시 + 주제 기록
  for (const n of [...claims, ...lights]) {
    n.data.reflected = true;
    n.data.topics = [...new Set([...(n.data.topics || []), ...(assigned.get(n.name) || [])])];
    if (!n.data.topics.length) delete n.data.topics;
    touched.add(n.name);
  }
  const noteLike = new Map([...allNotes, ...sources].map((n) => [n.name, n]));
  for (const name of touched) {
    const n = noteLike.get(name)!;
    writeFile(kpath(n.rel), stringifyDoc(n.data, n.body));
    written.push(n.rel);
  }

  const problems = verifyAll({ only: [...new Set(written)] });
  if (problems.length) {
    gitRevert(config.knowledgeDir);
    throw new Error(`reflect verify 실패(되돌림): ${problems.slice(0, 5).join(' / ')}`);
  }
  gitCommit(config.knowledgeDir, `reflect(${r.provider}): notes ${claims.length}, refs ${lights.length}, topics +${created}/${r.value.topics.length}`);

  const doneSources = new Set([...claims.flatMap((c) => c.data.sources || []), ...lights.map((l) => l.name)]);
  for (const it of Q.all()) {
    if (it.status !== 'reduced' || !doneSources.has(it.id)) continue;
    const src = sources.find((s) => s.name === it.id);
    const pendingClaims = (src?.data.claims || []).filter((c: string) => noteByName.get(c)?.data.reflected === false);
    if (!pendingClaims.length) Q.save(Object.assign(it, { status: 'done' }));
  }
  log(`reflect 완료: 주제 ${written.filter((w) => w.startsWith('topics/')).length}개 갱신(신규 ${created}), 관련 링크 ${touched.size}`);
  return claims.length + lights.length;
}

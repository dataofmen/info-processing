import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, kpath } from './config.ts';
import { readDoc, walk } from './util.ts';

export const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
export const linksOf = (body: string) => [...body.matchAll(LINK_RE)].map((m) => m[1].trim());

/** basename → 상대경로 */
export function nameMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of walk(config.knowledgeDir)) {
    const rel = path.relative(config.knowledgeDir, f);
    if (rel.startsWith('ops/')) continue;
    m.set(path.basename(f, '.md'), rel);
  }
  return m;
}

/**
 * 모델과 무관한 검증(arscontexta의 write-validate hook 대체).
 * only를 주면 그 파일만, 아니면 전체.
 */
export function verifyAll(opts: { only?: string[] } = {}): string[] {
  const problems: string[] = [];
  const names = nameMap();
  const files = opts.only?.length ? opts.only.map((r) => kpath(r)) : walk(kpath('notes')).concat(walk(kpath('topics')));

  // basename 충돌
  if (!opts.only) {
    const seen = new Map<string, string>();
    for (const f of walk(config.knowledgeDir)) {
      const b = path.basename(f, '.md');
      const rel = path.relative(config.knowledgeDir, f);
      if (rel.startsWith('ops/') || rel === 'AGENTS.md' || rel.startsWith('self/')) continue;
      if (seen.has(b)) problems.push(`이름 충돌: ${seen.get(b)} ↔ ${rel}`);
      seen.set(b, rel);
    }
  }

  for (const f of files) {
    const rel = path.relative(config.knowledgeDir, f);
    if (!fs.existsSync(f)) {
      problems.push(`없음: ${rel}`);
      continue;
    }
    const { data, body } = readDoc(f);
    if (!data.type) problems.push(`type 누락: ${rel}`);
    if (!data.title) problems.push(`title 누락: ${rel}`);
    const links = linksOf(body);
    for (const l of links) if (!names.has(l)) problems.push(`깨진 링크: ${rel} → [[${l}]]`);
    if (data.type === 'claim') {
      if (!Array.isArray(data.sources) || !data.sources.length) problems.push(`출처 누락: ${rel}`);
      else for (const s of data.sources) if (!links.includes(s)) problems.push(`출처 링크 누락: ${rel} (${s})`);
    }
    if (data.type === 'topic') {
      const lines = body.split('\n').filter((l) => /^\s*[-*] /.test(l));
      for (const l of lines) if (!/\[\[[^\]]+\]\]/.test(l)) problems.push(`출처 없는 줄: ${rel}: ${l.slice(0, 50)}`);
    }
  }

  // raw 불변: 이미 commit된 raw 파일이 수정되면 차단
  try {
    const st = execFileSync('git', ['status', '--porcelain', '--', 'raw'], { cwd: config.knowledgeDir, encoding: 'utf8' });
    for (const line of st.split('\n')) if (/^( M|M |MM| D|D )/.test(line)) problems.push(`raw 수정 금지: ${line.slice(3)}`);
  } catch {}
  return problems;
}

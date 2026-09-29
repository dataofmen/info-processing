import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { embed } from './llm/runners.ts';

let db: DatabaseSync | null = null;
let mtime = 0;

/** 색인이 다시 만들어지면 자동으로 새 파일을 연다 */
export function idx(): DatabaseSync {
  const m = fs.existsSync(config.indexDb) ? fs.statSync(config.indexDb).mtimeMs : 0;
  if (!db || m !== mtime) {
    db?.close();
    if (!m) throw new Error('색인 없음: npm run index 를 먼저 실행하세요');
    db = new DatabaseSync(config.indexDb, { readOnly: true });
    mtime = m;
  }
  return db;
}

export type Hit = { path: string; name: string; type: string; title: string; summary: string; snippet?: string; score: number; created: string; platform?: string; tier?: string };

const COLS = 'd.path, d.name, d.type, d.title, d.summary, d.created, d.platform, d.tier';

function snippetOf(body: string, q: string) {
  const i = body.toLowerCase().indexOf(q.toLowerCase());
  const s = Math.max(0, i - 60);
  return i < 0 ? body.replace(/^---[\s\S]*?---/, '').replace(/[#>*\-\n]+/g, ' ').slice(0, 160) : (s ? '…' : '') + body.slice(s, i + q.length + 100).replace(/\n+/g, ' ');
}

function keyword(q: string, types: string[] | undefined, limit: number): Hit[] {
  const d = idx();
  const tf = types?.length ? `AND d.type IN (${types.map(() => '?').join(',')})` : '';
  const terms = q.split(/\s+/).filter(Boolean);
  let rows: any[] = [];
  if (terms.every((t) => [...t].length >= 3)) {
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    rows = d.prepare(`SELECT ${COLS}, d.body, bm25(fts, 5.0, 1.0) s FROM fts JOIN docs d ON d.path = fts.path WHERE fts MATCH ? ${tf} ORDER BY s LIMIT ?`).all(match, ...(types || []), limit) as any[];
  } else {
    const where = terms.map(() => '(d.title LIKE ? OR d.body LIKE ?)').join(' AND ');
    const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    rows = d.prepare(`SELECT ${COLS}, d.body, 0 s FROM docs d WHERE ${where} ${tf} ORDER BY (d.title LIKE ?) DESC, d.created DESC LIMIT ?`).all(...args, ...(types || []), `%${terms[0]}%`, limit) as any[];
  }
  return rows.map((r, i) => ({ ...r, snippet: snippetOf(r.body, terms[0]), body: undefined, score: 1 / (60 + i) }));
}

async function semantic(q: string, types: string[] | undefined, limit: number): Promise<Hit[]> {
  const d = idx();
  const has = d.prepare("SELECT 1 FROM sqlite_master WHERE name='emb'").get();
  if (!has) return [];
  const qv = (await embed([q]))?.[0];
  if (!qv) return [];
  const rows = d.prepare(`SELECT e.v, ${COLS} FROM emb e JOIN docs d ON d.path = e.path`).all() as any[];
  const qn = Math.hypot(...qv);
  const scored = rows
    .filter((r) => !types?.length || types.includes(r.type))
    .map((r) => {
      const v = new Float32Array(Uint8Array.from(r.v).buffer);
      let dot = 0, n = 0;
      for (let i = 0; i < v.length; i++) (dot += v[i] * qv[i]), (n += v[i] * v[i]);
      return { ...r, v: undefined, sim: dot / (Math.sqrt(n) * qn) };
    })
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
  return scored.map((r, i) => ({ ...r, score: 1 / (60 + i) }));
}

/** 전문 + 의미 검색을 순위 융합(RRF) */
export async function search(q: string, opts: { types?: string[]; limit?: number } = {}): Promise<Hit[]> {
  const limit = opts.limit || 20;
  const [a, b] = [keyword(q, opts.types, limit * 2), await semantic(q, opts.types, limit * 2)];
  const m = new Map<string, Hit>();
  for (const h of [...a, ...b]) {
    const e = m.get(h.path);
    if (e) (e.score += h.score), (e.snippet ||= h.snippet);
    else m.set(h.path, { ...h });
  }
  return [...m.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}

export function getDoc(key: string) {
  const d = idx();
  const row = (d.prepare('SELECT * FROM docs WHERE path = ?').get(key) || d.prepare("SELECT * FROM docs WHERE name = ? ORDER BY CASE type WHEN 'raw' THEN 1 ELSE 0 END LIMIT 1").get(key)) as any;
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data), tags: JSON.parse(row.tags) };
}

export function backlinks(path: string) {
  return idx().prepare(`SELECT DISTINCT ${COLS} FROM links l JOIN docs d ON d.path = l.src WHERE l.dst_path = ? ORDER BY d.type, d.title`).all(path) as any[];
}

export function outlinks(path: string) {
  return idx().prepare(`SELECT DISTINCT ${COLS} FROM links l JOIN docs d ON d.path = l.dst_path WHERE l.src = ?`).all(path) as any[];
}

/** 1~2단계 이웃 그래프 (raw 제외) */
export function neighborhood(path: string, depth = 2, max = 60) {
  const d = idx();
  const nodes = new Map<string, any>();
  const edges = new Set<string>();
  const nb = d.prepare(`SELECT src a, dst_path b FROM links WHERE (src = ? OR dst_path = ?) AND dst_path IS NOT NULL`);
  const info = d.prepare('SELECT path, name, type, title FROM docs WHERE path = ?');
  let frontier = [path];
  const add = (p: string) => {
    if (nodes.has(p) || nodes.size >= max) return false;
    const r = info.get(p) as any;
    if (!r || r.type === 'raw') return false;
    nodes.set(p, r);
    return true;
  };
  add(path);
  for (let k = 0; k < depth; k++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const e of nb.all(p, p) as any[]) {
        const other = e.a === p ? e.b : e.a;
        if (add(other)) next.push(other);
        if (nodes.has(other) && nodes.has(p)) edges.add([e.a, e.b].join('\u0000'));
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges: [...edges].map((e) => e.split('\u0000')).map(([s, t]) => ({ s, t })) };
}

export function recent(types: string[], limit = 30, offset = 0) {
  return idx()
    .prepare(`SELECT ${COLS} FROM docs d WHERE d.type IN (${types.map(() => '?').join(',')}) ORDER BY d.created DESC LIMIT ? OFFSET ?`)
    .all(...types, limit, offset) as any[];
}

export function topics() {
  return idx().prepare("SELECT d.path, d.name, d.title, d.summary, d.updated, (SELECT count(*) FROM links l WHERE l.src = d.path) n FROM docs d WHERE d.type='topic' ORDER BY n DESC").all() as any[];
}

export function stats() {
  const d = idx();
  const byType = d.prepare('SELECT type, count(*) c FROM docs GROUP BY type').all() as any[];
  const built = (d.prepare("SELECT v FROM meta WHERE k='built_at'").get() as any)?.v;
  return { byType: Object.fromEntries(byType.map((r) => [r.type, r.c])), built };
}

/** 최근 수집: 출처 노트가 있으면 출처 노트, 없으면(보관만·처리 전) 원문 */
export function recentCaptures(limit = 30, offset = 0) {
  return idx()
    .prepare(
      `SELECT ${COLS} FROM docs d WHERE d.type = 'source'
       OR (d.type = 'raw' AND NOT EXISTS (SELECT 1 FROM docs s WHERE s.type = 'source' AND s.name || '.raw' = d.name))
       ORDER BY d.created DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as any[];
}

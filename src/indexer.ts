import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { embed } from './llm/runners.ts';
import { ensureDir, hash, log, readDoc, walk } from './util.ts';
import { LINK_RE } from './verify.ts';

/**
 * index.db 는 파생물이다. 지우고 다시 만들어도 knowledge/ 만으로 100% 복원된다.
 * 임베딩은 비용을 아끼려고 별도 캐시(embed-cache.db, 내용 해시 키)를 둔다 — 이것도 지워도 된다.
 */
const SCHEMA = `
CREATE TABLE docs(path TEXT PRIMARY KEY, name TEXT, type TEXT, title TEXT, platform TEXT, tier TEXT,
  created TEXT, updated TEXT, tags TEXT, source TEXT, summary TEXT, body TEXT, data TEXT);
CREATE INDEX docs_name ON docs(name);
CREATE INDEX docs_type ON docs(type, created);
CREATE TABLE links(src TEXT, dst TEXT, dst_path TEXT);
CREATE INDEX links_dst ON links(dst_path);
CREATE INDEX links_src ON links(src);
CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body, tokenize='trigram');
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
`;

export function openIndex(): DatabaseSync {
  return new DatabaseSync(config.indexDb, { readOnly: false });
}

function openCache() {
  const db = new DatabaseSync(path.join(path.dirname(config.indexDb), 'embed-cache.db'));
  db.exec('CREATE TABLE IF NOT EXISTS emb(h TEXT PRIMARY KEY, model TEXT, v BLOB)');
  return db;
}

const typeOf = (rel: string, data: any) => data.type || (rel.startsWith('raw/') ? 'raw' : rel.startsWith('topics/') ? 'topic' : 'note');

export async function buildIndex(opts: { embeddings?: boolean } = {}) {
  ensureDir(path.dirname(config.indexDb));
  const tmp = `${config.indexDb}.building`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const files = walk(config.knowledgeDir).filter((f) => !path.relative(config.knowledgeDir, f).startsWith('ops/'));
  const names = new Map<string, string>();
  for (const f of files) names.set(path.basename(f, '.md'), path.relative(config.knowledgeDir, f));

  const insDoc = db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insLink = db.prepare('INSERT INTO links VALUES (?,?,?)');
  const insFts = db.prepare('INSERT INTO fts VALUES (?,?,?)');
  const forEmbed: { path: string; text: string }[] = [];
  db.exec('BEGIN');
  for (const f of files) {
    const rel = path.relative(config.knowledgeDir, f);
    const { data, body } = readDoc(f);
    const type = typeOf(rel, data);
    const title = String(data.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(f, '.md'));
    const summary = type === 'source' ? (body.match(/## 요약\n([\s\S]*?)(?=\n## |$)/)?.[1] || '').trim() : type === 'topic' ? String(data.description || '') : '';
    insDoc.run(
      rel,
      path.basename(f, '.md'),
      type,
      title,
      data.platform || null,
      data.tier || null,
      String(data.captured || data.created || ''),
      String(data.updated || ''),
      JSON.stringify(data.tags || []),
      data.source || null,
      summary,
      body,
      JSON.stringify(data),
    );
    insFts.run(rel, title, body);
    for (const m of body.matchAll(LINK_RE)) {
      const dst = m[1].trim();
      insLink.run(rel, dst, names.get(dst) || null);
    }
    if (type !== 'raw') forEmbed.push({ path: rel, text: `${title}\n${summary || body}`.slice(0, 2000) });
  }
  db.exec('COMMIT');

  let embedded = 0;
  if (opts.embeddings !== false) {
    db.exec('CREATE TABLE emb(path TEXT PRIMARY KEY, v BLOB)');
    const cache = openCache();
    const model = config.ollama.embedModel;
    const get = cache.prepare('SELECT v FROM emb WHERE h=? AND model=?');
    const put = cache.prepare('INSERT OR REPLACE INTO emb VALUES (?,?,?)');
    const ins = db.prepare('INSERT INTO emb VALUES (?,?)');
    const missing: { path: string; text: string; h: string }[] = [];
    for (const d of forEmbed) {
      const h = hash(d.text, 16);
      const row = get.get(h, model) as any;
      if (row) ins.run(d.path, row.v);
      else missing.push({ ...d, h });
    }
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const vecs = await embed(batch.map((b) => b.text));
      if (!vecs) {
        if (i === 0) log('임베딩 서버 없음 → 의미 검색 없이 색인(전문 검색만)');
        break;
      }
      batch.forEach((b, j) => {
        const blob = Buffer.from(new Float32Array(vecs[j]).buffer);
        put.run(b.h, model, blob);
        ins.run(b.path, blob);
      });
    }
    embedded = (db.prepare('SELECT count(*) c FROM emb').get() as any).c;
    cache.close();
  }
  db.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', new Date().toISOString());
  db.close();
  fs.renameSync(tmp, config.indexDb);
  log(`색인 완료: 문서 ${files.length}, 임베딩 ${embedded}`);
  return { docs: files.length, embedded };
}

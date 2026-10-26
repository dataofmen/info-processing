import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { ensureDir, makeId, normalizeUrl, now, platformOf, readJson, writeJson } from './util.ts';

export type Status = 'queued' | 'captured' | 'triaged' | 'reduced' | 'done' | 'failed' | 'waiting';
export type Tier = 'deep' | 'light' | 'archive';

export type Item = {
  id: string;
  url: string;
  platform: string;
  status: Status;
  force_deep?: boolean;
  memo?: string;
  origin: 'telegram' | 'mcp' | 'cli' | 'web';
  chat_id?: number;
  file?: string; // 업로드된 파일(PDF·Web Clipper md)
  tier?: Tier;
  raw?: string;
  title?: string;
  attempts: number;
  error?: string;
  waiting_stage?: Status;
  created_at: string;
  updated_at: string;
};

const file = (id: string) => path.join(config.queueDir, `${id}.json`);

export function all(): Item[] {
  ensureDir(config.queueDir);
  return fs
    .readdirSync(config.queueDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Item | null>(path.join(config.queueDir, f), null))
    .filter((x): x is Item => !!x)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const get = (id: string) => readJson<Item | null>(file(id), null);

export function save(item: Item) {
  item.updated_at = now();
  writeJson(file(item.id), item);
  return item;
}

export function findByUrl(url: string): Item | undefined {
  const n = normalizeUrl(url);
  return all().find((i) => i.url === n);
}

export type EnqueueResult = { item: Item; duplicate: boolean; promoted?: boolean };

export function enqueue(input: { url?: string; file?: string; name?: string; memo?: string; forceDeep?: boolean; origin: Item['origin']; chatId?: number }): EnqueueResult {
  const key = input.url ? normalizeUrl(input.url) : `file://${input.name || path.basename(input.file!)}`;
  const existing = all().find((i) => i.url === key);
  if (existing) {
    if (input.forceDeep && existing.tier !== 'deep') {
      existing.force_deep = true;
      existing.tier = 'deep';
      if (['done', 'reduced', 'triaged'].includes(existing.status)) existing.status = 'triaged';
      if (input.memo) existing.memo = input.memo;
      save(existing);
      return { item: existing, duplicate: true, promoted: true };
    }
    return { item: existing, duplicate: true };
  }
  const platform = input.url ? platformOf(key) : /\.pdf$/i.test(key) ? 'pdf' : 'clip';
  const t = now();
  const item: Item = {
    id: makeId(key, platform),
    url: key,
    platform,
    status: 'queued',
    force_deep: !!input.forceDeep,
    memo: input.memo,
    origin: input.origin,
    chat_id: input.chatId,
    file: input.file,
    attempts: 0,
    created_at: t,
    updated_at: t,
  };
  save(item);
  return { item, duplicate: false };
}

export function counts() {
  const c: Record<string, number> = {};
  for (const i of all()) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

/**
 * 깊게로 올린다.
 * 원문이 있으면 증류 대기(triaged). 원문이 없으면 수집 대기(queued)를 유지한다.
 * 로그인 보류(waiting, 아직 원문 없음)는 보류 그대로 두고 깊은 표시만 한다.
 */
export function promote(id: string): Item | null {
  const it = get(id);
  if (!it) return null;
  it.force_deep = true;
  it.tier = 'deep';
  if (!it.raw) {
    const waitingForCapture = it.status === 'waiting' && it.waiting_stage === 'queued';
    if (it.status !== 'queued' && !waitingForCapture) {
      it.status = 'queued';
      it.attempts = 0;
      it.waiting_stage = undefined;
      it.error = undefined;
    }
  } else {
    it.status = 'triaged';
    it.waiting_stage = undefined;
    it.error = undefined;
  }
  return save(it);
}

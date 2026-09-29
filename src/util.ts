import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { config, kpath } from './config.ts';

export const now = () => new Date().toISOString();
export const log = (...a: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const TRACKING = /^(utm_|fbclid|gclid|igshid|mc_|ref_src|ref_url|s$|t$|si$|trk|rcm|lipi|mibextid)/i;

export function normalizeUrl(input: string): string {
  const u = new URL(input.trim());
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.replace(/^(www\.|mobile\.|m\.)/, '');
  if (u.hostname === 'twitter.com') u.hostname = 'x.com';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

export function platformOf(url: string): string {
  const h = new URL(url).hostname;
  if (/(^|\.)x\.com$|twitter\.com$/.test(h)) return 'x';
  if (/linkedin\.com$/.test(h)) return 'linkedin';
  if (/threads\.(net|com)$/.test(h)) return 'threads';
  if (/\.pdf$/i.test(new URL(url).pathname)) return 'pdf';
  return 'web';
}

export const hash = (s: string, n = 8) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);

export function makeId(url: string, platform: string, date = new Date()): string {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-${platform}-${hash(url)}`;
}

export function slugify(s: string, max = 60): string {
  return s
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
    .replace(/[ .]+$/, '');
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeFile(p: string, content: string) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

export function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export const writeJson = (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2) + '\n');

export type Doc = { data: Record<string, any>; body: string };

export function parseDoc(text: string): Doc {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  let data: Record<string, any> = {};
  try {
    data = YAML.parse(m[1]) || {};
  } catch {
    data = {};
  }
  return { data, body: m[2] };
}

export function stringifyDoc(data: Record<string, any>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return `---\n${YAML.stringify(clean, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export const readDoc = (p: string): Doc => parseDoc(fs.readFileSync(p, 'utf8'));

export function walk(dir: string, ext = '.md'): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 파이프라인 전역 잠금. 한 번에 하나만 쓴다. */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const lock = path.join(config.root, 'data', `${name}.lock`);
  ensureDir(path.dirname(lock));
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) {
      log(`잠금 사용 중(${name}, pid ${pid}) — 건너뜀`);
      return undefined;
    }
    fs.writeFileSync(lock, String(process.pid));
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ---------- git ----------
function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function gitInit(dir: string) {
  ensureDir(dir);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(dir, ['init', '-q', '-b', 'main']);
  }
}

export function gitCommit(dir: string, message: string): boolean {
  git(dir, ['add', '-A']);
  const status = git(dir, ['status', '--porcelain']);
  if (!status.trim()) return false;
  git(dir, ['-c', 'user.name=info-pipeline', '-c', 'user.email=pipeline@localhost', 'commit', '-q', '-m', message]);
  if (config.gitPush) {
    try {
      git(dir, ['push', '-q']);
    } catch (e: any) {
      log('push 실패(다음 실행에서 재시도):', e.message?.split('\n')[0]);
    }
  }
  return true;
}

/** verify 실패 시 마지막 commit으로 되돌림 */
export function gitRevert(dir: string) {
  try {
    git(dir, ['checkout', '-q', 'HEAD', '--', 'notes', 'topics']);
  } catch {}
  git(dir, ['clean', '-q', '-fd', '--', 'notes', 'topics']);
}

export const relK = (p: string) => path.relative(config.knowledgeDir, p);
export { kpath };

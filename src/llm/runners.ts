import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { log } from '../util.ts';

export class LimitError extends Error {}

const LIMIT_RE = /rate.?limit|quota|usage limit|limit reached|resource.?exhausted|\b429\b|too many requests|exceeded|credit balance|hit your limit/i;

function sandboxDir() {
  const d = path.join(os.tmpdir(), 'info-pipeline-llm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(cmd: string, args: string[], stdin: string | null, timeoutMs = 6 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: sandboxDir(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} 시간 초과`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      const both = `${out}\n${err}`;
      if (code !== 0) {
        if (LIMIT_RE.test(both)) return reject(new LimitError(`${cmd}: 사용량 제한`));
        return reject(new Error(`${cmd} 종료 코드 ${code}: ${err.slice(-400) || out.slice(-400)}`));
      }
      if (!out.trim() && LIMIT_RE.test(err)) return reject(new LimitError(`${cmd}: 사용량 제한`));
      resolve(out);
    });
    if (stdin !== null) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

const HEAD = '위 지시를 따르세요. 파일을 만들거나 도구를 쓰지 말고, 설명 없이 JSON 한 개만 출력하세요.';

const providers: Record<string, (prompt: string) => Promise<string>> = {
  agy: (prompt) => run('agy', ['--disable-slash-commands', '--model', config.agy.model, '-p', `${prompt}\n\n${HEAD}`], null, config.agy.timeoutMs),
  codex: (prompt) => run('codex', ['exec', '--skip-git-repo-check', '-s', 'read-only', `${prompt}\n\n${HEAD}`], null),
  claude: (prompt) => run('claude', ['-p', '--output-format', 'text', '--disallowedTools', 'Bash,Edit,Write,WebFetch,WebSearch,Task'], `${prompt}\n\n${HEAD}`),
  ollama: async (prompt) => {
    const r = await fetch(`${config.ollama.url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: config.ollama.chatModel, stream: false, format: 'json', think: false, messages: [{ role: 'user', content: `${prompt}\n\n${HEAD}` }] }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return ((await r.json()) as any).message.content;
  },
};

export function parseJson(text: string): any {
  const s = text.replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('JSON 없음');
  return JSON.parse(s.slice(start, end + 1));
}

export type LlmResult<T> = { value: T; provider: string };

/**
 * 순서대로 시도. 사용량 제한이면 다음 프로바이더로, 모두 제한이면 LimitError.
 * validate가 던지면(형식 불량) 같은 프로바이더로 1회 재시도 후 다음으로.
 */
export async function ask<T>(order: string[], prompt: string, validate: (v: any) => T): Promise<LlmResult<T>> {
  let limited = 0, unavailable = 0, tried = 0;
  let lastErr: Error | null = null;
  for (const name of order) {
    const fn = providers[name];
    if (!fn) continue;
    tried++;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await fn(attempt ? `${prompt}\n\n(직전 출력이 형식 오류였습니다: ${lastErr?.message}. 스키마를 정확히 지키세요.)` : prompt);
        return { value: validate(parseJson(out)), provider: name };
      } catch (e: any) {
        lastErr = e;
        if (e instanceof LimitError) {
          limited++;
          log(`${name} 사용량 제한 → 다음 프로바이더`);
          break;
        }
        if (e.code === 'ENOENT' || /ECONNREFUSED|fetch failed|Auth method|not logged in|login required|종료 코드 41|시간 초과|timed? out/i.test(e.message)) {
          unavailable++;
          log(`${name} 사용 불가(${e.code || e.message}) → 다음`);
          break;
        }
        log(`${name} 실패(${attempt + 1}/2): ${e.message.slice(0, 200)}`);
      }
    }
  }
  if (limited && limited + unavailable === tried) throw new LimitError('모든 프로바이더 사용량 제한');
  throw lastErr || new Error('사용 가능한 프로바이더 없음');
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  try {
    const r = await fetch(`${config.ollama.url}/api/embed`, { method: 'POST', body: JSON.stringify({ model: config.ollama.embedModel, input: texts }) });
    if (!r.ok) return null;
    return ((await r.json()) as any).embeddings;
  } catch {
    return null;
  }
}

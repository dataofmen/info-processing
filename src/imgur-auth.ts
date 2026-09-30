/**
 * Imgur refresh token 발급 (OAuth 계정 연결).
 *
 *   npm run imgur:auth                 발급 → .env 의 IMGUR_REFRESH_TOKEN 에 기록
 *   npm run imgur:auth -- --check      저장된 토큰으로 계정 연결만 확인
 *   npm run imgur:auth -- --test-upload  작은 테스트 이미지를 올렸다가 바로 삭제
 *
 * 준비: .env 에 IMGUR_CLIENT_ID, IMGUR_CLIENT_SECRET 을 직접 넣는다.
 *       Imgur 앱 설정(https://imgur.com/account/settings/apps)의 Authorization callback URL 을
 *       아래 CALLBACK 과 똑같이 맞춘다.
 * 토큰·시크릿은 화면에 출력하지 않는다. 결과는 .env 에만 쓴다.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ENV_PATH = path.resolve(ROOT, args.includes('--env') ? args[args.indexOf('--env') + 1] : '.env');
const PORT = 8765;
const CALLBACK = `http://localhost:${PORT}/imgur/callback`;

function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} 없음. .env.example 을 복사해 만드세요.`);
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 다른 줄은 건드리지 않고 한 키만 바꾼다 */
function setEnv(key: string, value: string) {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
  const tmp = `${ENV_PATH}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number; account_username?: string };

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const r = await fetch('https://api.imgur.com/oauth2/token', { method: 'POST', body: new URLSearchParams(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`토큰 요청 실패 (HTTP ${r.status}${j.data?.error ? `: ${j.data.error}` : j.error ? `: ${j.error}` : ''})`);
  return j;
}

async function me(accessToken: string) {
  const r = await fetch('https://api.imgur.com/3/account/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`계정 확인 실패 (HTTP ${r.status})`);
  return j.data?.url as string;
}

async function refresh(env: Record<string, string>) {
  if (!env.IMGUR_REFRESH_TOKEN) throw new Error('IMGUR_REFRESH_TOKEN 이 비어 있습니다. 먼저 npm run imgur:auth 로 발급하세요.');
  return tokenRequest({ refresh_token: env.IMGUR_REFRESH_TOKEN, client_id: env.IMGUR_CLIENT_ID, client_secret: env.IMGUR_CLIENT_SECRET, grant_type: 'refresh_token' });
}

async function testUpload(accessToken: string) {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2f5bea' } }).png().toBuffer();
  const form = new FormData();
  form.append('image', new Blob([png]), 'test.png');
  form.append('type', 'file');
  form.append('title', 'info-pipeline 연결 테스트 (자동 삭제)');
  const up = await fetch('https://api.imgur.com/3/image', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form });
  const j: any = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error(`테스트 업로드 실패 (HTTP ${up.status})`);
  const del = await fetch(`https://api.imgur.com/3/image/${j.data.deletehash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  console.log(`✓ 업로드 성공 → ${del.ok ? '바로 삭제함' : `삭제 실패(HTTP ${del.status}) — Imgur에서 직접 지워 주세요: ${j.data.link}`}`);
  const limit = up.headers.get('x-ratelimit-userremaining') || up.headers.get('x-post-rate-limit-remaining');
  if (limit) console.log(`  남은 호출 한도: ${limit}`);
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Imgur 연결</title><body style="font:16px/1.6 -apple-system,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">
<h2>${msg}</h2><p>이 창은 닫아도 됩니다. 터미널로 돌아가세요.</p>
<script>
// 암시적(token) 방식으로 돌아온 경우: 토큰이 URL #fragment 에 있어 서버가 볼 수 없다 → 서버로 넘긴 뒤 주소창에서 지운다
if (location.hash.includes('refresh_token')) {
  fetch('/imgur/fragment', { method: 'POST', body: location.hash.slice(1) }).then(() => { history.replaceState(null, '', location.pathname); document.querySelector('h2').textContent = '연결 완료'; });
}
</script>`;

async function authorize(env: Record<string, string>) {
  const state = crypto.randomBytes(12).toString('hex');
  const url = `https://api.imgur.com/oauth2/authorize?client_id=${encodeURIComponent(env.IMGUR_CLIENT_ID)}&response_type=code&state=${state}`;

  const tokens = await new Promise<Tokens>((resolve, reject) => {
    const timer = setTimeout(() => (server.close(), reject(new Error('5분 안에 승인하지 않아 종료했습니다.'))), 5 * 60 * 1000);
    const done = (t: Tokens, res: http.ServerResponse) => {
      res.end(PAGE('연결 완료'));
      clearTimeout(timer);
      server.close();
      resolve(t);
    };
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const u = new URL(req.url || '/', `http://localhost:${PORT}`);
      try {
        if (u.pathname === '/imgur/callback') {
          if (u.searchParams.get('error')) throw new Error(`승인 거부: ${u.searchParams.get('error')}`);
          const code = u.searchParams.get('code');
          if (!code) return void res.end(PAGE('확인 중…')); // fragment 방식이면 페이지 스크립트가 처리
          if (u.searchParams.get('state') !== state) throw new Error('state 불일치 — 다시 실행하세요.');
          const t = await tokenRequest({ client_id: env.IMGUR_CLIENT_ID, client_secret: env.IMGUR_CLIENT_SECRET, grant_type: 'authorization_code', code });
          return done(t, res);
        }
        if (u.pathname === '/imgur/fragment' && req.method === 'POST') {
          let body = '';
          for await (const c of req) body += c;
          const p = new URLSearchParams(body);
          if (!p.get('refresh_token')) throw new Error('refresh_token 없음');
          return done({ access_token: p.get('access_token')!, refresh_token: p.get('refresh_token')!, expires_in: Number(p.get('expires_in') || 0), account_username: p.get('account_username') || undefined }, res);
        }
        res.statusCode = 404;
        res.end('not found');
      } catch (e: any) {
        res.end(PAGE(`실패: ${e.message}`));
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });
    server.on('error', (e: any) => reject(e.code === 'EADDRINUSE' ? new Error(`포트 ${PORT} 사용 중. 다른 imgur:auth 가 떠 있는지 확인하세요.`) : e));
    server.listen(PORT, '127.0.0.1', () => {
      console.log('브라우저에서 Imgur 승인 화면을 엽니다. 로그인 후 "Allow"를 누르세요.');
      console.log(`(자동으로 안 열리면 이 주소를 직접 여세요: ${url})`);
      execFile('open', [url], () => {});
    });
  });

  setEnv('IMGUR_REFRESH_TOKEN', tokens.refresh_token);
  const who = tokens.account_username || (await me(tokens.access_token).catch(() => '?'));
  console.log(`✓ 연결됨: Imgur 계정 "${who}"`);
  console.log(`✓ refresh token 을 ${path.relative(ROOT, ENV_PATH) || ENV_PATH} 에 저장했습니다 (값은 출력하지 않음).`);
  return tokens.access_token;
}

async function main() {
  const env = readEnv();
  if (!env.IMGUR_CLIENT_ID || !env.IMGUR_CLIENT_SECRET) {
    console.log(`${ENV_PATH} 에 IMGUR_CLIENT_ID 와 IMGUR_CLIENT_SECRET 을 먼저 넣어 주세요.
  - 값은 https://imgur.com/account/settings/apps 에서 확인 (Client Secret 은 "generate new secret")
  - 같은 화면의 Authorization callback URL 을 다음으로 설정: ${CALLBACK}`);
    process.exit(1);
  }

  let accessToken: string;
  if (args.includes('--check') || args.includes('--test-upload')) {
    const t = await refresh(env);
    console.log(`✓ 저장된 토큰 유효: Imgur 계정 "${t.account_username || (await me(t.access_token))}"`);
    if (t.refresh_token && t.refresh_token !== env.IMGUR_REFRESH_TOKEN) setEnv('IMGUR_REFRESH_TOKEN', t.refresh_token);
    accessToken = t.access_token;
  } else {
    console.log(`Imgur 앱의 Authorization callback URL 이 ${CALLBACK} 인지 확인하세요.`);
    accessToken = await authorize(env);
  }
  if (args.includes('--test-upload')) await testUpload(accessToken);
  if (!args.includes('--check') && !args.includes('--test-upload')) {
    console.log('\n다음: npm run imgur:auth -- --test-upload 로 업로드 확인 → 서비스 재시작(launchctl kickstart -k gui/$(id -u)/com.hm.info-pipeline)');
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});

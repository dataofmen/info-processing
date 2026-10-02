import { config } from './config.ts';
import * as Q from './queue.ts';
import { gitCommit, log, readJson, withLock, writeJson } from './util.ts';
import { initKnowledge } from './init.ts';
import { runCapture } from './stages/capture.ts';
import { runProcess } from './stages/process.ts';
import { runReflect } from './stages/reflect.ts';
import { buildIndex } from './indexer.ts';
import { verifyAll } from './verify.ts';
import { notify } from './notify.ts';
import { loginSession } from './capture/browser.ts';
import { saveOpsSnapshot } from './ops.ts';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

async function stage(name: string, fn: () => Promise<unknown>) {
  return withLock('pipeline', async () => {
    try {
      const r = await fn();
      return r;
    } catch (e: any) {
      log(`${name} 오류:`, e.message);
      await notify(`⚠️ ${name} 단계 오류: ${e.message.slice(0, 300)}`);
    }
  });
}

const capture = (retryWaiting = false) =>
  stage('capture', async () => {
    const n = await runCapture({ retryWaiting });
    if (n) {
      gitCommit(config.assetsDir, `assets: ${n}건`);
      await buildIndex();
    }
    return n;
  });
const process_ = () => stage('process', async () => ((await runProcess()) ? buildIndex() : 0));
const reflect = () => stage('reflect', async () => ((await runReflect()) ? buildIndex() : 0));

async function health() {
  const c = Q.counts();
  const today = new Date().toISOString().slice(0, 10);
  const todays = Q.all().filter((i) => i.created_at.startsWith(today)).length;
  const problems = verifyAll();
  const ops = saveOpsSnapshot(3);
  const action = ops.suggestions[0] || '이상 징후 없음';
  await notify(
    `📋 일일 상태 ${today}\n수집 ${todays}건 · 대기 ${(c.queued || 0) + (c.captured || 0) + (c.triaged || 0)} · 증류 대기 ${c.reduced || 0} · 보류 ${c.waiting || 0} · 실패 ${c.failed || 0}\n최근 3일 수집 성공률 ${ops.capture_rate}% · 부분 저장 ${ops.partial_rate}% · 원자 노트 ${ops.claims}개\n검증 문제 ${problems.length}건\n진단: ${action}`,
  );
}

/** 상주 프로세스: 봇 + 웹 + MCP(HTTP) + 일정 */
async function serve() {
  initKnowledge();
  await buildIndex().catch((e) => log('초기 색인 실패', e.message));
  const { startWeb } = await import('./web/server.ts');
  const { mcpHttp } = await import('./mcp.ts');
  const { startBot } = await import('./bot.ts');
  startWeb();
  mcpHttp();
  let kick: NodeJS.Timeout | null = null;
  startBot(() => {
    if (kick) clearTimeout(kick);
    kick = setTimeout(() => capture(), 3000);
  });

  // 일정(맥미니 로컬 시각). 같은 날 같은 슬롯은 한 번만.
  const SLOTS: [string, string, () => Promise<unknown>][] = [
    ['process-noon', '12:00', process_],
    ['process-evening', '19:00', process_],
    ['process-night', '02:00', process_],
    ['reflect', '03:30', reflect],
    ['health', '08:00', health],
    ['ops-snapshot', '08:05', async () => { saveOpsSnapshot(3); }],
    ['retry-login', '08:10', () => capture(true)],
  ];
  const statePath = path.join(config.root, 'data', 'schedule.json');
  const tick = async () => {
    const d = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = d.toLocaleDateString('sv');
    const st = readJson<Record<string, string>>(statePath, {});
    for (const [key, at, fn] of SLOTS) {
      if (hm >= at && st[key] !== day) {
        st[key] = day;
        writeJson(statePath, st);
        log(`일정 실행: ${key}`);
        await fn();
      }
    }
    if (Q.all().some((i) => i.status === 'queued')) await capture();
  };
  // 처음 켤 때 지난 슬롯을 한꺼번에 돌리지 않도록 오늘 지난 슬롯은 표시만 한다
  {
    const d = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const st = readJson<Record<string, string>>(statePath, {});
    for (const [key, at] of SLOTS) if (hm >= at && !st[key]) st[key] = d.toLocaleDateString('sv');
    writeJson(statePath, st);
  }
  setInterval(() => tick().catch((e) => log('tick 오류', e.message)), 60_000);
  tick();
}

async function main() {
  switch (cmd) {
    case 'init':
      initKnowledge();
      return log('knowledge 초기화:', config.knowledgeDir);
    case 'add': {
      initKnowledge();
      for (const u of args.filter((a) => /^https?:/.test(a))) {
        const r = Q.enqueue({ url: u, memo: opt('--memo'), forceDeep: flag('--deep'), origin: 'cli' });
        log(r.duplicate ? `중복: ${r.item.id} (${r.item.status})` : `추가: ${r.item.id}`);
      }
      return;
    }
    case 'capture':
      return void (await capture(flag('--retry')));
    case 'process':
      return void (await process_());
    case 'reflect':
      return void (await reflect());
    case 'run': // 전 단계 한 번에
      await capture(true);
      await process_();
      await reflect();
      return;
    case 'index':
      return void (await buildIndex({ embeddings: !flag('--no-embed') }));
    case 'verify': {
      const p = verifyAll();
      p.forEach((x) => console.log('-', x));
      return log(`검증 문제 ${p.length}건`);
    }
    case 'status':
      return console.log(Q.counts());
    case 'health':
      return health();
    case 'ops':
      return console.log(JSON.stringify(saveOpsSnapshot(Number(opt('--days') || 3)), null, 2));
    case 'retry': {
      for (const i of Q.all().filter((i) => i.status === 'failed' || (i.status === 'waiting' && flag('--waiting')))) {
        Q.save(Object.assign(i, { status: i.raw ? 'captured' : 'queued', attempts: 0, error: undefined, waiting_stage: undefined }));
        log('재시도 대기열:', i.id);
      }
      return;
    }
    case 'login':
      return loginSession();
    case 'mcp':
      return (await import('./mcp.ts')).mcpStdio();
    case 'web':
      return (await import('./web/server.ts')).startWeb();
    case 'serve':
      return serve();
    default:
      console.log(`사용법: npm run cli -- <명령>
  init | add <url...> [--deep] [--memo 메모] | capture [--retry] | process | reflect | run
  index [--no-embed] | verify | status | health | ops [--days 3] | retry [--waiting] | login | mcp | web | serve`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

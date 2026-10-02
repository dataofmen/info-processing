import fs from 'node:fs';
import path from 'node:path';
import { config, kpath } from './config.ts';
import * as Q from './queue.ts';
import { readDoc, walk, writeJson } from './util.ts';
import { verifyAll } from './verify.ts';

const ageMs = (days: number) => days * 24 * 60 * 60 * 1000;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

export type OpsMetrics = ReturnType<typeof opsMetrics>;

export function opsMetrics(days = 3) {
  const since = Date.now() - ageMs(days);
  const items = Q.all().filter((i) => Date.parse(i.created_at) >= since);
  const attempted = items.filter((i) => (i.attempts || 0) > 0);
  const captured = items.filter((i) => !!i.raw);
  const failed = items.filter((i) => i.status === 'failed');
  const waiting = items.filter((i) => i.status === 'waiting');
  const pending = items.filter((i) => ['queued', 'captured', 'triaged', 'reduced'].includes(i.status));

  const platform: Record<string, { total: number; captured: number; failed: number; waiting: number }> = {};
  for (const i of items) {
    const p = (platform[i.platform] ||= { total: 0, captured: 0, failed: 0, waiting: 0 });
    p.total++;
    if (i.raw) p.captured++;
    if (i.status === 'failed') p.failed++;
    if (i.status === 'waiting') p.waiting++;
  }

  const rawFiles = walk(kpath('raw'));
  let partial = 0;
  let recentRaw = 0;
  for (const f of rawFiles) {
    try {
      const d = readDoc(f).data || {};
      const t = Date.parse(String(d.captured || ''));
      if (!Number.isFinite(t) || t < since) continue;
      recentRaw++;
      if (d.quality === 'partial') partial++;
    } catch {}
  }

  const sourceFiles = walk(kpath('notes/sources'));
  const providers: Record<string, number> = {};
  let sources = 0;
  for (const f of sourceFiles) {
    try {
      const d = readDoc(f).data || {};
      const t = Date.parse(String(d.captured || ''));
      if (!Number.isFinite(t) || t < since) continue;
      sources++;
      const p = String(d.processed_by || 'unknown');
      providers[p] = (providers[p] || 0) + 1;
    } catch {}
  }

  let claims = 0;
  for (const f of walk(kpath('notes'))) {
    if (f.includes(`${path.sep}sources${path.sep}`)) continue;
    try {
      const d = readDoc(f).data || {};
      const t = Date.parse(String(d.created || ''));
      if (d.type === 'claim' && Number.isFinite(t) && t >= since) claims++;
    } catch {}
  }

  const problems = verifyAll();
  const captureRate = pct(captured.length, attempted.length || items.length);
  const partialRate = pct(partial, recentRaw);

  const suggestions: string[] = [];
  if (attempted.length >= 3 && captureRate < 90) suggestions.push(`수집 성공률이 ${captureRate}%입니다. 실패·보류가 많은 플랫폼의 로그인/추출 경로를 우선 점검하세요.`);
  if (recentRaw >= 3 && partialRate >= 20) suggestions.push(`부분 저장률이 ${partialRate}%입니다. 짧은 본문 플랫폼의 전용 추출기 또는 Web Clipper fallback을 강화하세요.`);
  const badPlatforms = Object.entries(platform).filter(([, v]) => v.total >= 2 && v.failed + v.waiting > 0);
  for (const [name, v] of badPlatforms) suggestions.push(`${name}: 최근 ${v.total}건 중 실패 ${v.failed} · 로그인 보류 ${v.waiting}건입니다.`);
  if (problems.length) suggestions.push(`지식 검증 문제 ${problems.length}건이 있습니다. 깨진 링크·출처 누락을 우선 수정하세요.`);
  if (pending.length >= 10) suggestions.push(`처리 대기 ${pending.length}건입니다. process 실행 빈도 또는 1회 처리 상한을 검토하세요.`);
  if (!suggestions.length) suggestions.push('최근 운영 지표에서 즉시 조치가 필요한 이상 징후가 없습니다.');

  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    total: items.length,
    attempted: attempted.length,
    captured: captured.length,
    capture_rate: captureRate,
    failed: failed.length,
    waiting: waiting.length,
    pending: pending.length,
    partial,
    partial_rate: partialRate,
    recent_raw: recentRaw,
    sources,
    claims,
    providers,
    platform,
    verify_problems: problems,
    suggestions,
  };
}

export function saveOpsSnapshot(days = 3) {
  const m = opsMetrics(days);
  const p = path.join(config.root, 'data', 'ops-latest.json');
  writeJson(p, m);
  return m;
}

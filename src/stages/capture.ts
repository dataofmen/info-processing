import fs from 'node:fs';
import path from 'node:path';
import { kpath } from '../config.ts';
import * as Q from '../queue.ts';
import { notify } from '../notify.ts';
import { gitCommit, log, stringifyDoc, writeFile, now } from '../util.ts';
import { config } from '../config.ts';
import { LoginRequired, closeBrowser, download, render } from '../capture/browser.ts';
import { fromClipperMd, fromFxTwitter, fromHtml, fromPdf, type Extracted } from '../capture/extract.ts';
import { storeFile, storeImages } from '../capture/assets.ts';

const loginAlerted = new Set<string>();

async function isPdf(url: string) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return /application\/pdf/.test(r.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

async function extract(item: Q.Item): Promise<Extracted & { pdf?: string; source?: string }> {
  if (item.file) {
    const buf = fs.readFileSync(item.file);
    const name = path.basename(item.file);
    if (/\.pdf$/i.test(name)) return { ...fromPdf(buf, name.replace(/\.pdf$/i, '')), pdf: storeFile(item.id, buf, 'source.pdf') };
    if (/\.md$/i.test(name)) return fromClipperMd(buf.toString('utf8'));
    return await fromHtml(buf.toString('utf8'), item.url);
  }
  if (item.platform === 'pdf') {
    const { buf } = await download(item.url);
    return { ...fromPdf(buf, decodeURIComponent(path.basename(new URL(item.url).pathname)).replace(/\.pdf$/i, '')), pdf: storeFile(item.id, buf, 'source.pdf') };
  }
  if (item.platform === 'x') {
    try {
      const r = await render(item.url, 'x');
      const x = await fromHtml(r.html, r.finalUrl);
      if (x.wordCount >= 5) return x;
    } catch (e) {
      if (e instanceof LoginRequired) log('X 로그인 필요 → FxTwitter 대체 경로');
    }
    return await fromFxTwitter(item.url);
  }
  if (await isPdf(item.url)) {
    const { buf } = await download(item.url);
    return { ...fromPdf(buf, item.url), pdf: storeFile(item.id, buf, 'source.pdf') };
  }
  const r = await render(item.url, item.platform);
  if (/application\/pdf/.test(r.contentType)) {
    const { buf } = await download(item.url);
    return { ...fromPdf(buf, item.url), pdf: storeFile(item.id, buf, 'source.pdf') };
  }
  return await fromHtml(r.html, r.finalUrl);
}

export async function captureOne(item: Q.Item): Promise<boolean> {
  item.attempts++;
  try {
    const x = await extract(item);
    const quality = x.wordCount < 15 && !/!\[/.test(x.markdown) ? 'partial' : 'complete';
    const { markdown, images } = await storeImages(item.id, x.markdown, x.title);
    const rel = path.join('raw', item.id.slice(0, 4), item.id.slice(4, 6), `${item.id}.raw.md`);
    const data = {
      type: 'raw',
      id: item.id,
      title: x.title,
      source: x.source || item.url,
      platform: item.platform,
      author: x.author,
      published: x.published,
      captured: now(),
      site: x.site,
      description: x.description,
      language: x.language,
      word_count: x.wordCount,
      extractor: x.extractor,
      quality,
      images: images.length ? images : undefined,
      pdf: x.pdf,
      memo: item.memo,
    };
    writeFile(kpath(rel), stringifyDoc(data, `# ${x.title}\n\n${markdown}`));
    gitCommit(config.knowledgeDir, `capture: ${item.id} ${x.title.slice(0, 60)}`);
    Object.assign(item, { status: 'captured', raw: rel, title: x.title, error: undefined });
    Q.save(item);
    const warn = quality === 'partial' ? '\n⚠️ 본문이 짧습니다(부분 저장). 필요하면 Web Clipper 파일로 다시 보내 주세요.' : '';
    await notify(`저장됨: ${x.title.slice(0, 80)}\n${item.platform} · 이미지 ${images.length} · ${x.extractor}${warn}`, item.chat_id);
    return true;
  } catch (e: any) {
    if (e instanceof LoginRequired) {
      Object.assign(item, { status: 'waiting', waiting_stage: 'queued', error: e.message });
      Q.save(item);
      if (!loginAlerted.has(e.platform)) {
        loginAlerted.add(e.platform);
        await notify(`🔐 ${e.platform} 재로그인 필요. 맥미니에서 npm run login 후 대기 중인 글을 다시 처리합니다.`);
      }
      return false;
    }
    log('capture 실패', item.url, e.message);
    if (item.attempts < 2) {
      item.error = e.message;
      Q.save(item);
      return false;
    }
    Object.assign(item, { status: 'failed', error: e.message });
    Q.save(item);
    await notify(`❌ 추출 실패: ${item.url}\n${e.message}\n→ 그 기기의 Web Clipper로 "파일로 저장" 후 봇에 보내 주세요.`, item.chat_id);
    return false;
  }
}

export async function runCapture(opts: { retryWaiting?: boolean } = {}) {
  const items = Q.all().filter((i) => i.status === 'queued' || (opts.retryWaiting && i.status === 'waiting' && i.waiting_stage === 'queued'));
  if (!items.length) return 0;
  log(`capture: ${items.length}건`);
  let ok = 0;
  try {
    for (const it of items) {
      if (await captureOne(it)) ok++;
      await new Promise((r) => setTimeout(r, 2500)); // 사람 속도
    }
  } finally {
    await closeBrowser();
  }
  return ok;
}

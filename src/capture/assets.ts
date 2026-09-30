import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config, kpath } from '../config.ts';
import { ensureDir, log, readJson, writeJson } from '../util.ts';
import { download } from './browser.ts';

type ImageMap = Record<string, { original: string; imgur?: string; deletehash?: string }>;
const mapPath = () => kpath('ops', 'image-map.json');

let imgurToken: { token: string; exp: number } | null = null;

async function imgurAccessToken(): Promise<string | null> {
  const { clientId, clientSecret, refreshToken } = config.imgur;
  if (!clientId) return null;
  if (!clientSecret || !refreshToken) return null; // 익명 업로드는 보존성이 약해 쓰지 않는다
  if (imgurToken && imgurToken.exp > Date.now()) return imgurToken.token;
  const r = await fetch('https://api.imgur.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error(`Imgur 토큰 갱신 실패 ${r.status}`);
  const j: any = await r.json();
  imgurToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return imgurToken.token;
}

async function uploadImgur(buf: Buffer, title: string, filename = 'image.webp'): Promise<{ link: string; deletehash: string } | null> {
  const token = await imgurAccessToken().catch((e) => {
    log(e.message);
    return null;
  });
  if (!token) return null;
  const form = new FormData();
  form.append('image', new Blob([buf]), filename);
  form.append('type', 'file');
  form.append('title', title.slice(0, 120));
  const r = await fetch('https://api.imgur.com/3/image', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    log(`Imgur 업로드 실패 ${r.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    return null;
  }
  const j: any = await r.json();
  return { link: j.data.link, deletehash: j.data.deletehash };
}

/** 이미지 URL을 받아 assets/YYYY/MM/<id>/img-NN.webp 로 저장하고 문서에 쓸 URL을 돌려준다 */
export async function storeImages(id: string, markdown: string, title: string): Promise<{ markdown: string; images: string[] }> {
  const re = /!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const urls = [...new Set([...markdown.matchAll(re)].map((m) => m[2]).filter((u) => /^https?:/.test(u)))];
  const y = id.slice(0, 4), mo = id.slice(4, 6);
  const rel = path.join(y, mo, id);
  const dir = path.join(config.assetsDir, rel);
  const map = readJson<ImageMap>(mapPath(), {});
  const replace = new Map<string, string>();
  const images: string[] = [];
  let n = 0;
  for (const u of urls.slice(0, 20)) {
    n++;
    try {
      const { buf, type } = await download(u);
      if (buf.length < 1500) continue; // 추적 픽셀·아이콘
      ensureDir(dir);
      const gif = /gif/.test(type);
      const name = `img-${String(n).padStart(2, '0')}.${gif ? 'gif' : 'webp'}`;
      const out = gif ? buf : await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      fs.writeFileSync(path.join(dir, name), out);
      const local = `${rel}/${name}`;
      const uploadBuf = gif ? out : await sharp(out).png().toBuffer();
      const uploadName = gif ? name : name.replace(/\.webp$/i, '.png');
      const up = await uploadImgur(uploadBuf, title, uploadName);
      map[local] = { original: u, imgur: up?.link, deletehash: up?.deletehash };
      replace.set(u, up?.link || `/assets/${local}`);
      images.push(local);
    } catch (e: any) {
      log(`이미지 저장 실패(원본 URL 유지): ${e.message}`);
    }
  }
  writeJson(mapPath(), map);
  const md = markdown.replace(re, (all, alt, u) => (replace.has(u) ? `![${alt}](${replace.get(u)})` : all));
  return { markdown: md, images };
}

export function storeFile(id: string, buf: Buffer, name: string): string {
  const rel = path.join(id.slice(0, 4), id.slice(4, 6), id, name);
  const p = path.join(config.assetsDir, rel);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, buf);
  return rel;
}

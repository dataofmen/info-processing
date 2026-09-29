import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Defuddle } from 'defuddle/node';
import { parseDoc } from '../util.ts';

export type Extracted = {
  title: string;
  author?: string;
  published?: string;
  site?: string;
  description?: string;
  language?: string;
  markdown: string;
  wordCount: number;
  extractor: string;
  extract_log?: Record<string, string>;
  doi?: string;
};

export async function fromHtml(html: string, url: string): Promise<Extracted> {
  const r = await Defuddle(html, url, { markdown: true });
  const markdown = (r.content || '').trim();
  return {
    title: (r.title || '').trim() || url,
    author: r.author || undefined,
    published: r.published || undefined,
    site: r.site || r.domain || undefined,
    description: r.description || undefined,
    language: r.language || undefined,
    markdown,
    wordCount: r.wordCount || markdown.split(/\s+/).length,
    extractor: `defuddle:${r.extractorType || 'generic'}`,
  };
}

const PDF_ARGS = ['-enc', 'UTF-8'];
let _ver = '';
function pdftotextVersion() {
  if (_ver) return _ver;
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  _ver = `${r.stdout || ''}${r.stderr || ''}`.match(/version\s+([\d.]+)/)?.[1] || '';
  return (_ver ||= 'unknown');
}

export function fromPdf(buf: Buffer, fallbackTitle: string): Extracted {
  const tmp = path.join(os.tmpdir(), `ip-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, buf);
  let text = '';
  let title = fallbackTitle;
  try {
    // -layout 은 두 단 조판을 한 줄에 나란히 붙여 읽기 순서를 섞는다 → 기본(읽기 순서) 모드
    text = execFileSync('pdftotext', PDF_ARGS.concat([tmp, '-']), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const info = execFileSync('pdfinfo', [tmp], { encoding: 'utf8' });
    const t = info.match(/^Title:[ \t]+(\S.*)$/m)?.[1]?.trim();
    if (t) title = t;
  } catch {}
  fs.rmSync(tmp, { force: true });
  if (title === fallbackTitle || /^\d{4}\.\d{4,5}$/.test(title)) {
    const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 8 && l.length < 160 && !/arXiv|^\d+$|permission|copyright|licen[sc]e|attribution|proceedings|conference/i.test(l));
    if (first) title = first.slice(0, 120);
  }
  let page = 1;
  const paged = `<!-- p.1 -->\n\n${text.replace(/\f/g, () => `\n\n<!-- p.${++page} -->\n\n`)}`;
  const doi = text.match(/\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)])/)?.[1];
  const clean = paged.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return {
    title,
    markdown: clean,
    wordCount: clean.split(/\s+/).filter(Boolean).length,
    extractor: clean.length > 200 ? 'pdftotext' : 'pdftotext:empty(스캔 PDF 가능성)',
    extract_log: { tool: 'pdftotext', version: pdftotextVersion(), args: PDF_ARGS.join(' '), at: new Date().toISOString(), pages: String(page) },
    doi,
  };
}

/** Web Clipper로 저장한 .md 파일(수동 경로) */
export function fromClipperMd(text: string): Extracted & { source?: string } {
  const { data, body } = parseDoc(text);
  const author = Array.isArray(data.author) ? data.author.join(', ') : data.author;
  return {
    title: data.title || body.match(/^#\s+(.+)$/m)?.[1] || 'untitled',
    author: author?.replace(/\[\[|\]\]/g, ''),
    published: data.published ? String(data.published) : undefined,
    description: data.description,
    markdown: body.trim(),
    wordCount: body.split(/\s+/).length,
    extractor: 'obsidian-web-clipper',
    source: data.source,
  };
}

/** X 대체 경로: 로그인 없이 FxTwitter 공개 API. (맥미니의 로그인 브라우저가 기본 경로) */
export async function fromFxTwitter(url: string): Promise<Extracted> {
  const m = new URL(url).pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!m) throw new Error('X 상태 URL 아님');
  const r = await fetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FxTwitter ${r.status}`);
  const t: any = (await r.json()).tweet;
  if (!t) throw new Error('FxTwitter 응답에 글 없음');
  const media = (x: any) =>
    [...(x.media?.photos || []).map((p: any) => `![](${p.url})`), ...(x.media?.videos || []).map((v: any) => `![영상 썸네일](${v.thumbnail_url})\n[영상](${v.url})`)].join('\n\n');
  const parts = [t.text, media(t)];
  if (t.quote) parts.push(`> **@${t.quote.author?.screen_name}** 인용\n>\n> ${String(t.quote.text).replace(/\n/g, '\n> ')}${media(t.quote) ? `\n\n${media(t.quote)}` : ''}\n>\n> ${t.quote.url}`);
  if (t.article?.content) parts.push(String(t.article.content));
  const markdown = parts.filter(Boolean).join('\n\n');
  return {
    title: `${t.author.name} on X: ${String(t.text).split('\n')[0].slice(0, 80)}`,
    author: `${t.author.name} (@${t.author.screen_name})`,
    published: t.created_timestamp ? new Date(t.created_timestamp * 1000).toISOString() : t.created_at,
    site: 'X',
    language: t.lang,
    markdown,
    wordCount: markdown.split(/\s+/).length,
    extractor: 'fxtwitter',
  };
}

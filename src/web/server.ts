import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { marked } from 'marked';
import { config } from '../config.ts';
import * as Q from '../queue.ts';
import * as S from '../query.ts';
import { log } from '../util.ts';
import { CSS, GRAPH_JS } from './assets.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;

const TYPE_LABEL: Record<string, string> = { topic: '주제', claim: '노트', source: '출처', raw: '원문' };
const TIER_LABEL: Record<string, string> = { deep: '깊게', light: '가볍게', archive: '보관만' };
const STATUS_LABEL: Record<string, string> = { queued: '대기', captured: '수집됨', triaged: '분류됨', reduced: '증류됨', done: '완료', failed: '실패', waiting: '보류' };

const badge = (type: string) => `<span class="badge t-${esc(type)}">${esc(TYPE_LABEL[type] || type)}</span>`;
const tierBadge = (t?: string) => (t ? `<span class="badge tier-${esc(t)}">${esc(TIER_LABEL[t] || t)}</span>` : '');
const date = (s?: string) => (s ? esc(String(s).slice(0, 10)) : '');

function layout(title: string, body: string, opts: { q?: string; active?: string } = {}) {
  const nav = [
    ['/', '홈'],
    ['/topics', '주제'],
    ['/sources', '출처'],
    ['/notes', '노트'],
    ['/ops', '운영'],
  ]
    .map(([h, l]) => `<a href="${h}" class="${opts.active === h ? 'on' : ''}">${l}</a>`)
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 지식</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${CSS}</style></head><body>
<header class="top"><div class="wrap bar"><a class="brand" href="/">지식</a>
<form action="/search" class="sf"><input name="q" value="${esc(opts.q || '')}" placeholder="검색 (한국어·영어, 의미 검색 포함)" autocomplete="off"></form>
<nav>${nav}</nav></div></header>
<main class="wrap">${body}</main></body></html>`;
}

function itemRow(h: any, extra = '') {
  return `<li class="row"><a href="/n/${enc(h.name)}"><div class="rt">${badge(h.type)}${tierBadge(h.tier)} <span class="ttl">${esc(h.title)}</span></div>
${h.snippet || h.summary ? `<div class="rs">${esc(String(h.snippet || h.summary).replace(/^- /gm, '').slice(0, 200))}</div>` : ''}
<div class="rm">${h.platform ? esc(h.platform) + ' · ' : ''}${date(h.created)}${extra}</div></a></li>`;
}

function renderMarkdown(body: string) {
  const d = S.idx();
  const has = d.prepare('SELECT 1 FROM docs WHERE name = ?');
  const withLinks = body.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, n, alias) => {
    const name = n.trim();
    const label = esc(alias || name);
    return has.get(name) ? `<a class="wl" href="/n/${enc(name)}">${label}</a>` : `<span class="wl dead">${label}</span>`;
  });
  return marked.parse(withLinks, { async: false }) as string;
}

const app = new Hono();

app.use('*', async (c, next) => {
  try {
    await next();
  } catch (e: any) {
    return c.html(layout('오류', `<div class="empty"><h2>문제가 생겼습니다</h2><p>${esc(e.message)}</p></div>`), 500);
  }
});

app.get('/assets/*', (c) => {
  const rel = decodeURIComponent(c.req.path.slice('/assets/'.length));
  const p = path.resolve(config.assetsDir, rel);
  if (!p.startsWith(config.assetsDir) || !fs.existsSync(p)) return c.notFound();
  const type = p.endsWith('.webp') ? 'image/webp' : p.endsWith('.gif') ? 'image/gif' : p.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
  return c.body(fs.readFileSync(p), 200, { 'content-type': type, 'cache-control': 'public, max-age=604800' });
});

app.get('/', (c) => {
  const st = S.stats();
  const q = Q.counts();
  const topics = S.topics().slice(0, 12);
  const recent = S.recentCaptures(12);
  const alerts = (q.failed || 0) + (q.waiting || 0);
  const body = `
<section class="stats">
  <div><b>${st.byType.topic || 0}</b><span>주제</span></div>
  <div><b>${st.byType.claim || 0}</b><span>원자 노트</span></div>
  <div><b>${st.byType.source || 0}</b><span>출처 노트</span></div>
  <div><b>${st.byType.raw || 0}</b><span>원문</span></div>
</section>
${alerts ? `<a class="alert" href="/ops">확인 필요 ${alerts}건 (실패 ${q.failed || 0} · 보류 ${q.waiting || 0}) →</a>` : ''}
<form class="capture" method="post" action="/capture"><input name="url" type="url" placeholder="URL 바로 수집하기" required><input name="memo" placeholder="메모(선택)"><label><input type="checkbox" name="deep"> 깊게</label><button>수집</button></form>
<div class="cols">
<section><h2>주제 지도 <a class="more" href="/topics">전체</a></h2>
${topics.length ? `<ul class="list">${topics.map((t: any) => `<li class="row"><a href="/n/${enc(t.name)}"><div class="rt">${badge('topic')} <span class="ttl">${esc(t.title)}</span></div><div class="rs">${esc(t.summary)}</div><div class="rm">링크 ${t.n} · ${date(t.updated)}</div></a></li>`).join('')}</ul>` : '<p class="muted">아직 주제가 없습니다. 새벽 reflect가 돌면 생깁니다.</p>'}
</section>
<section><h2>최근 수집 <a class="more" href="/sources">전체</a></h2>
<ul class="list">${recent.map((r: any) => itemRow(r)).join('') || '<p class="muted">아직 없습니다.</p>'}</ul>
</section></div>
<p class="foot muted">색인 ${date(st.built)} ${esc(String(st.built || '').slice(11, 16))} · 대기열 ${Object.entries(q).map(([k, v]) => `${STATUS_LABEL[k] || k} ${v}`).join(' · ') || '비어 있음'}</p>`;
  return c.html(layout('홈', body, { active: '/' }));
});

app.post('/capture', async (c) => {
  const f = await c.req.parseBody();
  const r = Q.enqueue({ url: String(f.url), memo: String(f.memo || '') || undefined, forceDeep: !!f.deep, origin: 'web' });
  const msg = r.duplicate ? (r.promoted ? '이미 있음 → 깊게로 올렸습니다' : `이미 저장됨 (${STATUS_LABEL[r.item.status]})`) : '대기열에 넣었습니다. 파이프라인이 곧 처리합니다.';
  return c.html(layout('수집', `<div class="empty"><h2>${esc(msg)}</h2><p class="muted">${esc(r.item.url)}</p><p><a href="/">← 홈</a> · <a href="/ops">운영 화면</a></p></div>`));
});

app.post('/promote/:id', (c) => {
  const it = Q.get(c.req.param('id'));
  if (it) Q.save(Object.assign(it, { tier: 'deep', force_deep: true, status: 'triaged' }));
  return c.redirect(`/n/${enc(c.req.param('id'))}`);
});

app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const type = c.req.query('type') || '';
  if (!q) return c.redirect('/');
  const hits = await S.search(q, { types: type ? [type] : undefined, limit: 40 });
  const tabs = ['', 'topic', 'claim', 'source', 'raw'].map((t) => `<a class="${t === type ? 'on' : ''}" href="/search?q=${enc(q)}&type=${t}">${t ? TYPE_LABEL[t] : '전체'}</a>`).join('');
  const body = `<h1 class="h">"${esc(q)}" 검색 결과 <small>${hits.length}건</small></h1><div class="tabs">${tabs}</div>
<ul class="list">${hits.map((h) => itemRow(h)).join('') || '<p class="muted">결과가 없습니다. 두 글자 이하 단어는 정확히 일치하는 것만 찾습니다.</p>'}</ul>`;
  return c.html(layout(`검색: ${q}`, body, { q }));
});

function listPage(c: any, title: string, active: string, types: string[], intro = '') {
  const page = Math.max(0, Number(c.req.query('p') || 0));
  const rows = S.recent(types, 50, page * 50);
  const body = `<h1 class="h">${esc(title)}</h1>${intro}<ul class="list">${rows.map((r: any) => itemRow(r)).join('') || '<p class="muted">없습니다.</p>'}</ul>
<div class="pager">${page ? `<a href="?p=${page - 1}">← 이전</a>` : ''}${rows.length === 50 ? `<a href="?p=${page + 1}">다음 →</a>` : ''}</div>`;
  return c.html(layout(title, body, { active }));
}

app.get('/sources', (c) => {
  const page = Math.max(0, Number(c.req.query('p') || 0));
  const rows = S.recentCaptures(50, page * 50);
  const body = `<h1 class="h">출처</h1><p class="muted">깊게·가볍게 등급은 출처 노트로, 보관만 등급과 처리 전 항목은 원문으로 보입니다.</p><ul class="list">${rows.map((r: any) => itemRow(r)).join('') || '<p class="muted">없습니다.</p>'}</ul>
<div class="pager">${page ? `<a href="?p=${page - 1}">← 이전</a>` : ''}${rows.length === 50 ? `<a href="?p=${page + 1}">다음 →</a>` : ''}</div>`;
  return c.html(layout('출처', body, { active: '/sources' }));
});
app.get('/notes', (c) => listPage(c, '원자 노트', '/notes', ['claim']));
app.get('/raw', (c) => listPage(c, '원문', '/sources', ['raw']));

app.get('/topics', (c) => {
  const ts = S.topics();
  const body = `<h1 class="h">주제 지도 <small>${ts.length}개</small></h1><div class="grid">${ts
    .map((t: any) => `<a class="card" href="/n/${enc(t.name)}"><h3>${esc(t.title)}</h3><p>${esc(t.summary)}</p><span class="muted">링크 ${t.n} · ${date(t.updated)}</span></a>`)
    .join('') || '<p class="muted">아직 없습니다.</p>'}</div>`;
  return c.html(layout('주제', body, { active: '/topics' }));
});

app.get('/n/:name', (c) => {
  const d = S.getDoc(decodeURIComponent(c.req.param('name')));
  if (!d) return c.html(layout('없음', '<div class="empty"><h2>노트를 찾을 수 없습니다</h2></div>'), 404);
  const fm = d.data || {};
  const back = S.backlinks(d.path);
  const out = S.outlinks(d.path);
  const qItem = d.type === 'source' || d.type === 'raw' ? Q.get(String(fm.id || '')) : null;
  const meta = [
    fm.source && `<a href="${esc(fm.source)}" target="_blank" rel="noopener">원문 링크 ↗</a>`,
    fm.author && `작성자 ${esc(fm.author)}`,
    fm.platform && esc(fm.platform),
    fm.published && `게시 ${date(fm.published)}`,
    (fm.captured || fm.created) && `수집 ${date(fm.captured || fm.created)}`,
    fm.processed_by && `증류 ${esc(fm.processed_by)}`,
    fm.extractor && esc(fm.extractor),
    fm.quality === 'partial' && '<b class="warn">부분 저장</b>',
  ]
    .filter(Boolean)
    .join(' · ');
  const tags = (d.tags || []).map((t: string) => `<a class="tag" href="/search?q=${enc(t)}">#${esc(t)}</a>`).join('');
  const promote = qItem && qItem.tier !== 'deep' ? `<form method="post" action="/promote/${enc(qItem.id)}" class="inline"><button class="ghost">깊게로 올리기</button></form>` : '';
  const pdf = fm.pdf ? `<p><a href="/assets/${esc(fm.pdf)}" target="_blank">PDF 원본 열기</a></p>` : '';
  const body = `<div class="doc">
<article>
  <div class="dm">${badge(d.type)}${tierBadge(fm.tier)} ${meta}</div>
  ${tags ? `<div class="tags">${tags}</div>` : ''}
  <div class="md">${renderMarkdown(d.body)}</div>${pdf}
  ${promote}
</article>
<aside>
  <section><h4>로컬 그래프</h4><div id="graph" data-src="/api/graph/${enc(d.path)}"></div></section>
  <section><h4>역링크 <small>${back.length}</small></h4>${back.length ? `<ul class="mini">${back.map((b: any) => `<li><a href="/n/${enc(b.name)}">${badge(b.type)} ${esc(b.title)}</a></li>`).join('')}</ul>` : '<p class="muted">없음</p>'}</section>
  <section><h4>나가는 링크 <small>${out.length}</small></h4>${out.length ? `<ul class="mini">${out.map((b: any) => `<li><a href="/n/${enc(b.name)}">${badge(b.type)} ${esc(b.title)}</a></li>`).join('')}</ul>` : '<p class="muted">없음</p>'}</section>
</aside></div><script>${GRAPH_JS}</script>`;
  return c.html(layout(d.title, body));
});

app.get('/api/graph/*', (c) => {
  const p = decodeURIComponent(c.req.path.slice('/api/graph/'.length));
  const g = S.neighborhood(p, 2, 50);
  return c.json({ center: p, nodes: g.nodes.map((n: any) => ({ id: n.path, name: n.name, type: n.type, title: n.title })), edges: g.edges });
});

app.get('/ops', (c) => {
  const items = Q.all().reverse();
  const groups = ['failed', 'waiting', 'queued', 'captured', 'triaged', 'reduced'];
  const counts = Q.counts();
  const sec = groups
    .map((g) => {
      const rows = items.filter((i) => i.status === g).slice(0, 50);
      if (!rows.length) return '';
      return `<section><h2>${STATUS_LABEL[g]} <small>${counts[g]}</small></h2><ul class="list">${rows
        .map((i) => `<li class="row"><div class="rt"><span class="badge st-${g}">${STATUS_LABEL[g]}</span>${tierBadge(i.tier)} <span class="ttl">${esc(i.title || i.url)}</span></div>
<div class="rm">${esc(i.platform)} · ${esc(i.origin)} · ${date(i.created_at)} ${esc(i.created_at.slice(11, 16))}${i.error ? ` · <span class="warn">${esc(i.error.slice(0, 160))}</span>` : ''}</div>
<div class="rm"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.url.slice(0, 80))}</a></div></li>`)
        .join('')}</ul></section>`;
    })
    .join('');
  const st = S.stats();
  const body = `<h1 class="h">운영</h1>
<section class="stats">${Object.entries(counts).map(([k, v]) => `<div><b>${v}</b><span>${STATUS_LABEL[k] || k}</span></div>`).join('')}</section>
<p class="muted">색인 갱신 ${esc(st.built || '-')} · 완료 항목은 여기 나오지 않습니다.</p>${sec || '<p class="muted">처리할 항목이 없습니다.</p>'}`;
  return c.html(layout('운영', body, { active: '/ops' }));
});

export function startWeb() {
  serve({ fetch: app.fetch, hostname: config.host, port: config.webPort });
  log(`웹 UI http://${config.host}:${config.webPort}`);
}

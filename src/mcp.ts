import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { config } from './config.ts';
import * as Q from './queue.ts';
import * as S from './query.ts';
import { log } from './util.ts';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

const GUIDE = `개인 지식 저장소(knowledge). 공개 웹 글·PDF를 원문(raw) → 출처 노트(source) → 원자 노트(claim) → 주제 지도(topic)로 증류한다.
읽는 순서: list_topics → get_note(주제) → 주제의 [[노트]] → 근거가 필요하면 get_source(원문).
답할 때는 노트 이름과 원문 URL을 근거로 함께 밝힌다. 원자 노트는 AI가 증류한 것이므로 중요한 주장은 원문으로 확인한다.`;

export function buildServer() {
  const s = new McpServer({ name: 'info-knowledge', version: '0.1.0' }, { instructions: GUIDE });

  s.registerTool(
    'search',
    {
      description: '지식 저장소 검색(전문 + 의미 검색 융합). 한국어·영어 모두 가능. types로 좁히기: topic, claim, source, raw',
      inputSchema: { query: z.string(), types: z.array(z.enum(['topic', 'claim', 'source', 'raw'])).optional(), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, types, limit }) => text(await S.search(query, { types, limit })),
  );

  s.registerTool(
    'get_note',
    { description: '노트·주제·출처 노트 본문을 이름 또는 경로로 가져온다. 역링크와 나가는 링크 포함', inputSchema: { name: z.string() } },
    async ({ name }) => {
      const d = S.getDoc(name);
      if (!d) return text(`없음: ${name}`);
      return text({ path: d.path, type: d.type, title: d.title, frontmatter: d.data, body: d.body, backlinks: S.backlinks(d.path).map((b) => b.name), outlinks: S.outlinks(d.path).map((b) => b.name) });
    },
  );

  s.registerTool(
    'get_source',
    { description: '원문(raw)을 가져온다. 출처 노트 id(예: 20260929-x-ab12cd34) 또는 경로', inputSchema: { id: z.string(), max_chars: z.number().int().optional() } },
    async ({ id, max_chars }) => {
      const d = S.getDoc(id.endsWith('.raw') ? id : `${id}.raw`) || S.getDoc(id);
      if (!d) return text(`없음: ${id}`);
      return text({ path: d.path, frontmatter: d.data, body: d.body.slice(0, max_chars || 30000) });
    },
  );

  s.registerTool('list_topics', { description: '주제 지도(MOC) 목록과 설명', inputSchema: {} }, async () => text(S.topics().map((t) => ({ name: t.name, description: t.summary, links: t.n, updated: t.updated }))));

  s.registerTool(
    'get_backlinks',
    { description: '이 노트를 인용한 노트 목록', inputSchema: { name: z.string() } },
    async ({ name }) => {
      const d = S.getDoc(name);
      return text(d ? S.backlinks(d.path) : `없음: ${name}`);
    },
  );

  s.registerTool(
    'list_recent',
    { description: '최근 수집·증류된 항목', inputSchema: { type: z.enum(['source', 'claim', 'topic', 'raw']).optional(), limit: z.number().int().max(100).optional() } },
    async ({ type, limit }) => text(S.recent([type || 'source'], limit || 20)),
  );

  // --- 쓰기 도구: git에 직접 쓰지 않고 대기열에만 넣는다 ---
  s.registerTool(
    'capture_url',
    { description: 'URL을 수집 대기열에 넣는다(맥미니 파이프라인이 처리). deep=true면 깊게 증류', inputSchema: { url: z.string().url(), memo: z.string().optional(), deep: z.boolean().optional() } },
    async ({ url, memo, deep }) => {
      const r = Q.enqueue({ url, memo, forceDeep: deep, origin: 'mcp' });
      return text(r.duplicate ? (r.promoted ? `이미 있음 → 깊게로 올림: ${r.item.id}` : `이미 저장됨: ${r.item.id} (${r.item.status})`) : `대기열 추가: ${r.item.id}`);
    },
  );

  s.registerTool(
    'promote',
    { description: '보관만/가볍게 등급의 출처를 깊게로 올려 다시 증류', inputSchema: { id: z.string() } },
    async ({ id }) => {
      const it = Q.get(id);
      if (!it) return text(`없음: ${id}`);
      Q.save(Object.assign(it, { tier: 'deep', force_deep: true, status: 'triaged' }));
      return text(`깊게로 올림: ${id} (다음 처리 때 증류)`);
    },
  );

  s.registerTool('status', { description: '파이프라인 상태(대기열·색인)', inputSchema: {} }, async () => text({ queue: Q.counts(), index: S.stats() }));

  return s;
}

export async function mcpStdio() {
  await buildServer().connect(new StdioServerTransport());
}

export function mcpHttp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (config.mcpToken && c.req.header('authorization') !== `Bearer ${config.mcpToken}`) return c.text('unauthorized', 401);
    await next();
  });
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildServer().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  serve({ fetch: app.fetch, hostname: config.host, port: config.mcpPort });
  log(`MCP(HTTP) http://${config.host}:${config.mcpPort}/mcp`);
}

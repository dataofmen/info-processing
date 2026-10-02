import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = process.env;
const p = (v: string | undefined, d: string) => path.resolve(root, v || d);
const list = (v: string | undefined, d: string) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  root,
  knowledgeDir: p(env.KNOWLEDGE_DIR, 'data/knowledge'),
  assetsDir: p(env.ASSETS_DIR, 'data/assets'),
  browserProfile: p(env.BROWSER_PROFILE, 'data/browser-profile'),
  indexDb: p(env.INDEX_DB, 'data/index.db'),
  queueDir: p(env.QUEUE_DIR, 'data/queue'),
  host: env.HOST || '127.0.0.1',
  webPort: Number(env.WEB_PORT || 4321),
  mcpPort: Number(env.MCP_PORT || 4322),
  mcpToken: env.MCP_TOKEN || '',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowed: list(env.TELEGRAM_ALLOWED_CHAT_IDS, ''),
  imgur: {
    clientId: env.IMGUR_CLIENT_ID || '',
    clientSecret: env.IMGUR_CLIENT_SECRET || '',
    refreshToken: env.IMGUR_REFRESH_TOKEN || '',
  },
  gitPush: env.GIT_PUSH === '1',
  llm: {
    triage: list(env.LLM_TRIAGE_ORDER, 'ollama,agy'),
    reduce: list(env.LLM_REDUCE_ORDER, 'agy,codex,claude'),
    reflect: list(env.LLM_REFLECT_ORDER, 'claude'),
  },
  agy: {
    model: env.AGY_MODEL || 'gemini-3.8-flash-low',
    timeoutMs: Number(env.AGY_TIMEOUT_MS || 90000),
  },
  ollama: {
    url: env.OLLAMA_URL || 'http://127.0.0.1:11434',
    chatModel: env.OLLAMA_CHAT_MODEL || 'qwen3:14b',
    embedModel: env.OLLAMA_EMBED_MODEL || 'bge-m3',
  },
  limits: {
    reducePerRun: 15,
    reflectNotesPerRun: 40,
    reweavePerRun: 10,
    rawCharsForLlm: 40000,
  },
};

export const kpath = (...parts: string[]) => path.join(config.knowledgeDir, ...parts);

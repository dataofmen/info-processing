import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'info-processing-snap-'));
process.env.SNAP_ROOT = root;
process.env.KNOWLEDGE_DIR = path.join(root, 'knowledge');
process.env.ASSETS_DIR = path.join(root, 'assets');
process.env.INDEX_DB = path.join(root, 'index.db');
process.env.QUEUE_DIR = path.join(root, 'queue');
process.env.CONVERSATION_CANDIDATE_DIR = path.join(root, 'candidates');
process.env.BROWSER_PROFILE = path.join(root, 'browser');
process.env.GIT_PUSH = '0';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '';
process.env.IMGUR_CLIENT_ID = '';
process.env.IMGUR_CLIENT_SECRET = '';
process.env.IMGUR_REFRESH_TOKEN = '';
process.env.MCP_TOKEN = '';

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { config } from '../config.ts';
import { ensureDir, log } from '../util.ts';

export class LoginRequired extends Error {
  platform: string;
  constructor(platform: string) {
    super(`${platform} 로그인 필요`);
    this.platform = platform;
  }
}

let ctx: BrowserContext | null = null;

export async function context(headless = true): Promise<BrowserContext> {
  if (ctx) return ctx;
  ensureDir(config.browserProfile);
  ctx = await chromium.launchPersistentContext(config.browserProfile, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 1800 },
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return ctx;
}

export async function closeBrowser() {
  await ctx?.close();
  ctx = null;
}

const LOGIN_WALL: Record<string, RegExp> = {
  linkedin: /linkedin\.com\/(authwall|login|checkpoint|uas\/login)/,
  x: /x\.com\/(i\/flow\/login|login)/,
  threads: /threads\.(net|com)\/login/,
};

async function settle(page: Page, ms = 6000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

async function expand(page: Page, platform: string) {
  if (platform === 'linkedin') {
    const buttons = page.locator(
      'button.feed-shared-inline-show-more-text__see-more-less-toggle, button:has-text("더보기"), button:has-text("see more"), button:has-text("…more")',
    );
    const n = Math.min(await buttons.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) await buttons.nth(i).click({ timeout: 1500 }).catch(() => {});
  }
  // 스레드·지연 로딩 이미지를 위해 조금 스크롤
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

export type Rendered = { html: string; finalUrl: string; contentType: string };

export async function render(url: string, platform: string): Promise<Rendered> {
  const c = await context();
  const page = await c.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const contentType = resp?.headers()['content-type'] || '';
    await settle(page);
    const finalUrl = page.url();
    const wall = LOGIN_WALL[platform];
    if (wall && wall.test(finalUrl)) throw new LoginRequired(platform);
    const status = resp?.status() || 0;
    if (status >= 400) throw new Error(`HTTP ${status} (없는 페이지이거나 접근 거부)`);
    if (platform === 'x') await page.locator('article').first().waitFor({ timeout: 12000 }).catch(() => {});
    await expand(page, platform);
    await settle(page, 3000);
    const html = await page.content();
    return { html, finalUrl, contentType };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 쿠키가 필요한 이미지·PDF를 브라우저 세션으로 받는다 */
export async function download(url: string): Promise<{ buf: Buffer; type: string }> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36' } });
    if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
  } catch {}
  const c = await context();
  const r = await c.request.get(url, { timeout: 30000 });
  if (!r.ok()) throw new Error(`다운로드 실패 ${r.status()} ${url}`);
  return { buf: Buffer.from(await r.body()), type: r.headers()['content-type'] || '' };
}

/** 사람이 직접 로그인하는 창 (npm run login) */
export async function loginSession() {
  const c = await context(false);
  const sites = ['https://x.com/login', 'https://www.linkedin.com/login', 'https://www.threads.net/login'];
  for (const s of sites) await (await c.newPage()).goto(s).catch(() => {});
  log('열린 탭에서 로그인한 뒤, 브라우저 창을 닫으세요.');
  await new Promise<void>((res) => c.on('close', () => res()));
  ctx = null;
}

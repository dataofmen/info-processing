import fs from 'node:fs';
import path from 'node:path';
import { Bot } from 'grammy';
import { config } from './config.ts';
import * as Q from './queue.ts';
import { ensureDir, log } from './util.ts';

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

/**
 * 메시지 규칙
 *  - URL(여러 개 가능)을 보내면 수집. 맨 앞에 ! 를 붙이면 "깊게" 강제.
 *  - URL 외의 텍스트는 메모("왜 저장했나")로 들어간다.
 *  - PDF / Web Clipper .md / .html 파일을 보내면 그 파일로 수집.
 *  - /status 대기열 상태
 */
export function startBot(onEnqueue: () => void) {
  if (!config.telegramToken) {
    log('TELEGRAM_BOT_TOKEN 없음 → 봇 비활성');
    return null;
  }
  const bot = new Bot(config.telegramToken);
  // 허용 목록이 비어 있으면 아무도 허용하지 않는다(대신 chat ID를 알려 준다)
  const allowed = (id?: number) => config.telegramAllowed.includes(String(id));

  bot.use(async (ctx, next) => {
    if (!allowed(ctx.chat?.id)) {
      log('허용되지 않은 chat 무시:', ctx.chat?.id);
      if (!config.telegramAllowed.length) await ctx.reply(`이 chat ID(${ctx.chat?.id})를 TELEGRAM_ALLOWED_CHAT_IDS에 넣어 주세요.`);
      return;
    }
    await next();
  });

  bot.command('status', async (ctx) => {
    const c = Q.counts();
    await ctx.reply(Object.entries(c).map(([k, v]) => `${k}: ${v}`).join('\n') || '대기열 비어 있음');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const urls = text.match(URL_RE) || [];
    if (!urls.length) return void (await ctx.reply('URL이나 파일을 보내 주세요. 앞에 ! 를 붙이면 깊게 증류합니다.'));
    const deep = text.startsWith('!');
    const memo = text.replace(URL_RE, '').replace(/^!/, '').trim() || undefined;
    const lines: string[] = [];
    for (const u of urls) {
      try {
        const r = Q.enqueue({ url: u, memo, forceDeep: deep, origin: 'telegram', chatId: ctx.chat.id });
        lines.push(r.duplicate ? (r.promoted ? `↑ 깊게로 올림: ${r.item.title || r.item.url}` : `이미 저장됨(${r.item.status}): ${r.item.title || r.item.url}`) : `⏳ 수집 중: ${r.item.url}`);
      } catch {
        lines.push(`URL 형식 오류: ${u}`);
      }
    }
    await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
    onEnqueue();
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name || `${doc.file_id}.bin`;
    if (!/\.(pdf|md|html?)$/i.test(name)) return void (await ctx.reply('PDF, .md(Web Clipper), .html 파일만 받습니다.'));
    if ((doc.file_size || 0) > 20 * 1024 * 1024) return void (await ctx.reply('20MB를 넘는 파일은 텔레그램 봇이 받을 수 없습니다. PDF URL로 보내 주세요.'));
    const f = await ctx.getFile();
    const r = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`);
    const dir = path.join(config.root, 'data', 'uploads');
    ensureDir(dir);
    const local = path.join(dir, `${Date.now()}-${name.replace(/[^\w.\-가-힣]/g, '_')}`);
    fs.writeFileSync(local, Buffer.from(await r.arrayBuffer()));
    const caption = ctx.message.caption?.trim();
    const res = Q.enqueue({ file: local, name, memo: caption?.replace(/^!/, '').trim() || undefined, forceDeep: caption?.startsWith('!'), origin: 'telegram', chatId: ctx.chat.id });
    await ctx.reply(res.duplicate ? `이미 저장됨: ${name}` : `⏳ 파일 수집 중: ${name}`);
    onEnqueue();
  });

  bot.catch((e) => log('봇 오류', e.message));
  bot.start({ drop_pending_updates: false, onStart: (me) => log(`텔레그램 봇 @${me.username} 시작`) });
  return bot;
}

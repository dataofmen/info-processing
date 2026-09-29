import { config } from './config.ts';
import { log } from './util.ts';

/** 텔레그램 Bot API로 직접 보낸다(봇 프로세스와 무관하게 파이프라인 어디서든) */
export async function notify(text: string, chatId?: number | string) {
  const targets = chatId ? [String(chatId)] : config.telegramAllowed;
  if (!config.telegramToken || !targets.length) {
    log('[알림]', text.replace(/\n/g, ' | '));
    return;
  }
  for (const id of targets) {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
    }).catch((e) => log('텔레그램 전송 실패', e.message));
  }
}

/**
 * Optional Telegram notifications.
 *
 * Credentials come from env (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), provided
 * via GitHub Actions secrets — never committed. When they are absent (local runs
 * or no secrets configured) notifications are silently skipped. Sending is
 * best-effort and never throws, so it cannot break a collection run.
 *
 * Policy:
 *   - data changed on a healthy source  -> silent message
 *   - source went ok -> failed           -> loud message
 *   - source went failed -> ok           -> loud (recovery) message
 *   - nothing changed and all ok         -> no message
 */

/**
 * @typedef {Object} SourceEvent
 * @property {string} name
 * @property {boolean} changed     Did the published file change this run?
 * @property {boolean|null} prevOk Previous status.ok (null if no previous doc).
 * @property {boolean} nowOk       Current status.ok.
 * @property {string} code         Current status code.
 * @property {number} groups
 * @property {string|null} sourceUpdatedAt
 */

/**
 * Turn per-source events into Telegram messages (pure, testable).
 * @param {SourceEvent[]} events
 * @returns {{text: string, silent: boolean}[]}
 */
export function buildNotifications(events) {
  const failures = events.filter((e) => !e.nowOk && e.prevOk !== false);
  const recoveries = events.filter((e) => e.nowOk && e.prevOk === false);
  const recoveredNames = new Set(recoveries.map((e) => e.name));
  const updates = events.filter((e) => e.changed && e.nowOk && !recoveredNames.has(e.name));

  const messages = [];

  const loud = [];
  for (const e of failures) loud.push(`⚠️ ${e.name}: збій (${e.code})`);
  for (const e of recoveries) loud.push(`✅ ${e.name}: відновлено (${e.groups} черг)`);
  if (loud.length) {
    messages.push({ text: ['Стан збору графіків відключень', ...loud].join('\n'), silent: false });
  }

  if (updates.length) {
    const lines = updates.map(
      (e) => `🔄 ${e.name}: оновлено${e.sourceUpdatedAt ? ` (${e.sourceUpdatedAt})` : ''}`,
    );
    messages.push({ text: ['Оновлення графіків відключень', ...lines].join('\n'), silent: true });
  }

  return messages;
}

/** Send one message via the Telegram Bot API. Never throws. */
export async function sendTelegram({ text, silent }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const threadId = process.env.TELEGRAM_THREAD_ID; // optional: forum-group topic
  if (!token || !chatId) return { sent: false, reason: 'no-credentials' };
  try {
    const payload = {
      chat_id: chatId,
      text,
      disable_notification: Boolean(silent),
      disable_web_page_preview: true,
    };
    if (threadId) payload.message_thread_id = Number(threadId);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { sent: false, reason: `http ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String(err && err.message) };
  }
}

/** Send a batch of messages best-effort; returns per-message results. */
export async function sendNotifications(messages) {
  const results = [];
  for (const message of messages) results.push(await sendTelegram(message));
  return results;
}

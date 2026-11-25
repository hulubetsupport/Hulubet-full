'use strict';

function buildStartMessage(firstName, webAppUrl, userId) {
  const name = firstName || 'Player';
  const refLink = userId ? `https://t.me/${process.env.BOT_USERNAME || 'Hulubetethbot'}/hulubet?startapp=${userId}` : '';
  return {
    text:
      `🦁 *Welcome to HuluBet Ultra, ${name}!*\n\n` +
      `• 12 Instant & Crash Games (Aviator, JetX, Fast Keno, Classic Keno, Roulette, Plinko, Slot 777, Avia Masters, Mega Block, Chicken Road 2, Lucky Chicken, Roasted Chicken)\n` +
      `• Live Sportsbook with Instant Cashout\n` +
      `• 20 ETB Welcome Bonus & 10% Daily Cashback (10:00 AM EAT)\n` +
      (refLink ? `\n🔗 Your Referral Link:\n\`${refLink}\`` : ''),
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 Open HuluBet Full Screen', web_app: { url: webAppUrl } }],
        [
          { text: '💰 Balance', callback_data: 'hb_balance' },
          { text: '📥 Deposit', callback_data: 'hb_deposit' }
        ],
        [
          { text: '👥 Invite & Earn 50 ETB', callback_data: 'hb_referral' },
          { text: '🛟 Support', url: 'https://t.me/Agent1hulubet' }
        ]
      ]
    }
  };
}

function registerTelegramBot(app, { pool, env, config, notify }) {
  const botToken = env.BOT_TOKEN || '';
  const botUsername = env.BOT_USERNAME || 'Hulubetethbot';

  const resolveWebAppUrl = req => {
    if (env.WEBAPP_URL) return env.WEBAPP_URL;
    if (req) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.get('host');
      if (host) return `${proto}://${host}/`;
    }
    return 'http://localhost:3000/';
  };

  async function tgApi(method, body) {
    if (!botToken || typeof fetch !== 'function') return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await r.json().catch(() => null);
    } catch (e) {
      console.warn('Telegram API error:', e.message);
      return null;
    }
  }

  async function handleUpdate(update, webAppUrl) {
    if (!update || typeof update !== 'object') return;
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat?.id;
      const uid = String(msg.from?.id || '');
      const text = String(msg.text || '').trim();
      if (!chatId) return;

      if (text.startsWith('/start') || text.startsWith('/menu')) {
        const refMatch = text.match(/^\/start\s+([A-Za-z0-9_-]{1,64})/);
        const urlWithRef = refMatch ? `${webAppUrl}?refId=${encodeURIComponent(refMatch[1])}` : webAppUrl;
        const payload = buildStartMessage(msg.from?.first_name, urlWithRef, uid);
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: payload.text,
          parse_mode: 'Markdown',
          reply_markup: payload.reply_markup
        });
      } else if (text === '/balance') {
        const u = (await pool.query('SELECT balance, wager_requirement_left FROM users WHERE user_id=$1', [uid])).rows[0];
        const reply = u
          ? `💰 Balance: *${Number(u.balance).toFixed(2)} ETB*\nWagering left: ${Number(u.wager_requirement_left || 0).toFixed(2)} ETB`
          : 'Tap "Open HuluBet Full Screen" from /start to activate your account and claim your 20 ETB Welcome Bonus!';
        await tgApi('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'Markdown' });
      } else if (text === '/deposit') {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '📥 Open HuluBet Full Screen and tap *Deposit* to pay via Telebirr or CBE.',
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📥 Open Cashier', web_app: { url: webAppUrl } }]] }
        });
      } else if (text === '/help') {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `Commands:\n/start - Launch HuluBet App\n/balance - Check wallet balance\n/deposit - Deposit instructions\nSupport: @Agent1hulubet`
        });
      }
      return;
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const uid = String(cq.from?.id || '');
      const data = cq.data;
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
      if (!chatId) return;

      if (data === 'hb_balance') {
        const u = (await pool.query('SELECT balance FROM users WHERE user_id=$1', [uid])).rows[0];
        const msg = u ? `💰 Your current balance is *${Number(u.balance).toFixed(2)} ETB*.` : 'Open the app once to initialize your wallet with 20 ETB Welcome Bonus.';
        await tgApi('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
      } else if (data === 'hb_deposit') {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: '📥 Deposit via *Telebirr* or *CBE* inside the HuluBet app (minimum 50 ETB).',
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📥 Deposit Now', web_app: { url: webAppUrl } }]] }
        });
      } else if (data === 'hb_referral') {
        const link = `https://t.me/${botUsername}/hulubet?startapp=${uid}`;
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: `👥 *Invite Friends & Earn ${config.REFERRAL_BONUS} ETB*\nShare your link:\n\`${link}\``,
          parse_mode: 'Markdown'
        });
      }
    }
  }

  app.post('/api/telegram/webhook', async (req, res) => {
    const secret = env.BOT_WEBHOOK_SECRET;
    if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      return res.status(403).json({ success: false });
    }
    try {
      await handleUpdate(req.body, resolveWebAppUrl(req));
    } catch (e) {
      console.error('Telegram webhook error:', e.message);
    }
    res.json({ ok: true });
  });

  app.get('/api/bot/status', (req, res) => {
    res.json({
      success: true,
      configured: Boolean(botToken),
      botUsername,
      webAppUrl: resolveWebAppUrl(req),
      webhookPath: '/api/telegram/webhook'
    });
  });

  if (botToken && env.ENABLE_BOT_POLLING === '1') {
    let offset = 0;
    const poll = async () => {
      try {
        const r = await tgApi('getUpdates', { offset, timeout: 20 });
        if (r && r.ok && Array.isArray(r.result)) {
          for (const upd of r.result) {
            offset = upd.update_id + 1;
            await handleUpdate(upd, resolveWebAppUrl(null));
          }
        }
      } catch (e) {}
      setTimeout(poll, 1500).unref();
    };
    setTimeout(poll, 2000).unref();
  }
}

module.exports = { buildStartMessage, registerTelegramBot };

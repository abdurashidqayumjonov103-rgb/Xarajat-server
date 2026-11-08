require('dotenv').config();

const TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET || '';
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '';
const ADMIN_TELEGRAM_IDS = new Set(
  ADMIN_ID.split(',').map(value => value.trim()).filter(Boolean)
);

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

async function telegram(method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram API xatosi');
  return data.result;
}

async function backend(path, actorId, options = {}) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Bot-Secret': BOT_INTERNAL_SECRET,
    'X-Telegram-Id': String(actorId)
  }, options.headers || {});
  const response = await fetch(BACKEND_URL + path, Object.assign({}, options, { headers }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Server xatosi (' + response.status + ')');
  return data;
}

function isAdmin(telegramId) {
  return ADMIN_TELEGRAM_IDS.has(String(telegramId));
}

async function handleStart(message) {
  const chatId = message.chat.id;
  const firstName = message.from.first_name || 'Foydalanuvchi';
  let subscriptionText = 'Obuna holatini yuklab bo‘lmadi.';

  try {
    const user = await backend('/api/auth', chatId, {
      method: 'POST',
      body: JSON.stringify({
        telegramId: chatId,
        firstName,
        username: message.from.username || ''
      })
    });
    if (user.isPro) {
      subscriptionText = '👑 Sizda <b>PRO</b> obuna faol.';
    } else if (user.isTrialActive) {
      subscriptionText = '🎁 7 kunlik bepul muddat faol. Qolgan kunlar: <b>' + user.daysLeft + '</b>.';
    } else {
      subscriptionText = '🆓 Siz hozir FREE tarifidasiz. PRO tarifini ilovada ko‘ring.';
    }
  } catch (error) {
    console.error('Auth xatosi:', error.message);
  }

  const buttons = [];
  if (WEBAPP_URL) {
    buttons.push([{ text: '🚀 Ilovani ochish', web_app: { url: WEBAPP_URL } }]);
  }
  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Assalomu alaykum, <b>' + escapeHtml(firstName) + '</b>! 👋\n\n' +
      '💸 <b>Xarajat AI</b> — shaxsiy moliyaviy yordamchingiz.\n\n' +
      subscriptionText + '\n\nPRO obunasi chek administrator tomonidan tekshirilib tasdiqlangandan keyin faollashadi.',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleAdminCommand(message) {
  const [command, ...args] = String(message.text || '').trim().split(/\s+/);
  const actorId = message.from.id;
  if (!isAdmin(actorId)) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Bu buyruq faqat administrator uchun.' });
    return;
  }

  try {
    if (command === '/admin' || command === '/prohelp') {
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: [
          '<b>PRO administrator buyruqlari</b>',
          '/progrant TELEGRAM_ID OY — PRO berish',
          '/propromo TELEGRAM_ID OY — promo PRO berish',
          '/proextend TELEGRAM_ID OY — muddat uzaytirish',
          '/prorevoke TELEGRAM_ID — PRO bekor qilish',
          '/price TARIF_ID NARX OY — tarif sozlash',
          '/prousers — faol PRO foydalanuvchilari',
          '/propayments — to‘lovlar',
          '/prorevenue — tushum'
        ].join('\n'),
        parse_mode: 'HTML'
      });
      return;
    }

    if (command === '/progrant' || command === '/propromo' || command === '/proextend') {
      const telegramId = Number(args[0]);
      const months = Number(args[1]);
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0 ||
          !Number.isSafeInteger(months) || months < 1 || months > 36) {
        throw new Error('Foydalanish: ' + command + ' TELEGRAM_ID OY (1–36)');
      }
      const endpoint = command === '/proextend' ? '/api/admin/subscriptions/extend' : '/api/admin/subscriptions/grant';
      const result = await backend(endpoint, actorId, {
        method: 'POST',
        body: JSON.stringify({
          telegramId,
          months,
          promo: command === '/propromo',
          note: 'Telegram admin: ' + actorId
        })
      });
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: '✅ Obuna yangilandi. Tugash sanasi: ' + new Date(result.expiresAt).toLocaleDateString('uz-UZ')
      });
      return;
    }

    if (command === '/prorevoke') {
      const telegramId = Number(args[0]);
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new Error('Foydalanish: /prorevoke TELEGRAM_ID');
      await backend('/api/admin/subscriptions/revoke', actorId, {
        method: 'POST',
        body: JSON.stringify({ telegramId })
      });
      await telegram('sendMessage', { chat_id: message.chat.id, text: '✅ PRO obunasi bekor qilindi.' });
      return;
    }

    if (command === '/price') {
      const planId = String(args[0] || '');
      const priceUzs = Number(args[1]);
      const durationMonths = Number(args[2]);
      if (!['1-month', '3-month', '12-month'].includes(planId) ||
          !Number.isSafeInteger(priceUzs) || priceUzs < 1000 ||
          !Number.isSafeInteger(durationMonths) || durationMonths < 1 || durationMonths > 36) {
        throw new Error('Foydalanish: /price 1-month|3-month|12-month NARX OY');
      }
      const result = await backend('/api/admin/plans/' + encodeURIComponent(planId), actorId, {
        method: 'PATCH',
        body: JSON.stringify({ priceUzs, durationMonths })
      });
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: '✅ ' + result.name + ': ' + result.price_uzs.toLocaleString('uz-UZ') +
          ' UZS / ' + result.duration_months + ' oy'
      });
      return;
    }

    if (command === '/prousers') {
      const users = await backend('/api/admin/pro-users', actorId);
      const text = users.length
        ? users.map(item => '• ' + item.user_telegram_id + ' — ' + new Date(item.expires_at).toLocaleDateString('uz-UZ')).join('\n')
        : 'Faol PRO foydalanuvchilari yo‘q.';
      await telegram('sendMessage', { chat_id: message.chat.id, text: text.slice(0, 4000) });
      return;
    }

    if (command === '/propayments') {
      const payments = await backend('/api/admin/payments', actorId);
      const text = payments.slice(0, 25).map(item =>
        '• ' + item.provider.toUpperCase() + ' · ' + item.amount_uzs +
        ' UZS · ' + item.status + ' · ' + item.user_telegram_id
      ).join('\n') || 'To‘lovlar mavjud emas.';
      await telegram('sendMessage', { chat_id: message.chat.id, text: text.slice(0, 4000) });
      return;
    }

    if (command === '/prorevenue') {
      const revenue = await backend('/api/admin/revenue', actorId);
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: 'Jami tushum: ' + Number(revenue.totalUzs).toLocaleString('uz-UZ') +
          ' UZS\nTo‘lovlar: ' + revenue.paymentCount
      });
    }
  } catch (error) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: '⚠️ ' + error.message });
  }
}

async function startBot() {
  if (!TOKEN || !BOT_INTERNAL_SECRET || !WEBAPP_URL || !ADMIN_TELEGRAM_IDS.size) {
    throw new Error('BOT_TOKEN, ADMIN_ID, BOT_INTERNAL_SECRET va WEBAPP_URL muhit o‘zgaruvchilarini sozlang.');
  }
  console.log('Xarajat AI Telegram bot ishga tushdi.');
  let offset = 0;

  while (true) {
    try {
      const query = new URLSearchParams({ offset: String(offset), timeout: '30' });
      const response = await fetch('https://api.telegram.org/bot' + TOKEN + '/getUpdates?' + query.toString());
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram polling xatosi');

      for (const update of data.result || []) {
        offset = update.update_id + 1;
        if (!update.message || !update.message.text) continue;
        if (/^\/start(?:@\w+)?(?:\s|$)/.test(update.message.text)) {
          await handleStart(update.message);
        } else if (update.message.text.startsWith('/')) {
          await handleAdminCommand(update.message);
        }
      }
    } catch (error) {
      console.error('Bot xatosi:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

if (require.main === module) {
  startBot().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { escapeHtml, isAdmin, startBot };

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const PORT = process.env.PORT || 3000;
const BACKEND_URL = (process.env.BACKEND_URL || ('http://127.0.0.1:' + PORT)).replace(/\/+$/, '');
const BOT_INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET || '';
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '';
const ADMIN_TELEGRAM_IDS = new Set(
  ADMIN_ID.split(',').map(value => value.trim()).filter(Boolean)
);
const handledApprovalButtons = new Set();
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function friendlyBotError(error) {
  const message = String(error && error.message || '');
  if (!message || error.status || /(?:https?:\/\/|fetch|network|server|backend|supabase|postgres|ECONN|undefined|null|error:)/i.test(message)) {
    return 'Xizmat vaqtincha ishlamayapti. Birozdan so‘ng qayta urinib ko‘ring.';
  }
  return message;
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
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = Object.assign(isFormData ? {} : { 'Content-Type': 'application/json' }, {
    'X-Bot-Secret': BOT_INTERNAL_SECRET,
    'X-Telegram-Id': String(actorId)
  }, options.headers || {});
  const response = await fetch(BACKEND_URL + path, Object.assign({}, options, { headers }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Server xatosi (' + response.status + ')');
    error.status = response.status;
    throw error;
  }
  return data;
}

function getPlanFromCaption(caption) {
  const match = String(caption || '').match(/(?:plan|tarif)\s*[=:]\s*([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : 'unknown';
}

async function sendReceiptToAdmins(message, photo, payment) {
  const userId = Number(message.from && message.from.id || message.chat.id);
  const planId = String(payment && payment.plan_id || getPlanFromCaption(message.caption))
    .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const paymentMonths = Number(payment && payment.duration_months);
  const hasPaymentMonths = Number.isSafeInteger(paymentMonths) && paymentMonths >= 1 && paymentMonths <= 36;
  const requestedMonths = hasPaymentMonths
    ? paymentMonths
    : planId !== 'unknown' ? planDurationMonths(planId) : null;
  const knownPlan = planId !== 'unknown' || requestedMonths !== null;
  const approvalPlanId = hasPaymentMonths
    ? 'months_' + paymentMonths
    : planId;
  const keyboard = {
    inline_keyboard: knownPlan
      ? [[
          {
            text: requestedMonths ? '✅ ' + requestedMonths + ' oylik PRO' : '✅ Tasdiqlash',
            callback_data: 'approve_' + userId + '_' + approvalPlanId
          },
          { text: '❌ Rad etish', callback_data: 'reject_' + userId }
        ]]
      : [
          [
            { text: '✅ 1 Oylik PRO', callback_data: 'approve_' + userId + '_days_30' },
            { text: '✅ 3 Oylik PRO', callback_data: 'approve_' + userId + '_days_90' }
          ],
          [
             { text: '✅ 6 Oylik PRO', callback_data: 'approve_' + userId + '_days_180' },
             { text: '✅ 1 Yillik PRO', callback_data: 'approve_' + userId + '_days_365' }
          ],
          [
             { text: '❌ Rad etish', callback_data: 'reject_' + userId }
          ]
        ]
  };
  const caption = (requestedMonths
    ? '📩 ' + requestedMonths + ' oylik PRO obunasi uchun ariza keldi'
    : '📩 PRO obunasi uchun ariza keldi') +
    '\nPRO to‘lov cheki\nFoydalanuvchi ID: ' + userId +
    (requestedMonths ? '\nObuna muddati: ' + requestedMonths + ' oy' : '') +
    '\nTarif ID: ' + planId +
    (payment && payment.amount_uzs ? '\nSumma: ' + payment.amount_uzs + ' UZS' : '') +
    (payment && payment.id ? '\nTo‘lov ID: ' + payment.id : '');
  let sent = 0;
  for (const adminId of ADMIN_TELEGRAM_IDS) {
    try {
      await telegram('sendPhoto', {
        chat_id: adminId,
        photo: photo.file_id,
        caption,
        reply_markup: keyboard
      });
      sent++;
    } catch (error) {
      console.error('Chekni administratorga yuborib bo‘lmadi (' + adminId + '):', error.message);
    }
  }
  if (!sent) throw new Error('Chekni administratorga yuborib bo‘lmadi.');
}

async function uploadReceiptToBackend(message, payment) {
  const file = await telegram('getFile', { file_id: message.photo[message.photo.length - 1].file_id });
  if (!file.file_path || (file.file_size && file.file_size > 5 * 1024 * 1024)) {
    throw new Error('Chek rasmi 5 MB dan oshmasligi yoki fayl manzili noto‘g‘ri.');
  }
  const fileResponse = await fetch('https://api.telegram.org/file/bot' + TOKEN + '/' + file.file_path);
  if (!fileResponse.ok) throw new Error('Telegramdan chek rasmini yuklab bo‘lmadi.');

  const extension = String(file.file_path).split('.').pop().toLowerCase();
  const mimeType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
  if (!mimeType) throw new Error('Chek uchun JPG, PNG yoki WebP rasm yuboring.');

  const form = new FormData();
  const reference = String(message.caption || '').trim().slice(0, 100) || 'Telegram bot orqali yuborildi';
  form.append('reference', reference);
  form.append('receipt', new Blob([await fileResponse.arrayBuffer()], { type: mimeType }), 'receipt.' + extension);
  await backend('/api/payments/' + encodeURIComponent(payment.id) + '/receipt', message.chat.id, {
    method: 'POST',
    body: form
  });
}

async function handlePaymentReceipt(message) {
  const chatId = message.chat.id;
  const photos = message.photo || [];
  const photo = photos[photos.length - 1];
  if (!photo || !photo.file_id) return;

  let payment = null;
  try {
    const payments = await backend('/api/payments/history', chatId);
    if (!Array.isArray(payments)) throw new Error('To‘lovlar ro‘yxati noto‘g‘ri javob qaytardi.');
    payment = payments.find(item => item.provider === 'manual' && (item.status === 'pending' || item.status === 'review')) || null;
  } catch (error) {
    console.error('PRO arizasi muddatini aniqlab bo‘lmadi (backend):', error.message);
  }

  // Backend javob bermasa yoki to'lov topilmasa, to'g'ridan-to'g'ri Supabase'dan izlash:
  if (!payment && supabase) {
    try {
      const res = await supabase.from('payments')
        .select('*')
        .eq('user_telegram_id', Number(chatId))
        .in('status', ['pending', 'review'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!res.error && res.data) {
        payment = res.data;
      } else if (res.error && (res.error.code === '42703' || String(res.error.message || '').includes('user_telegram_id'))) {
        // Agar user_telegram_id ustuni bo'lmasa, legacy telegram_id ustuni orqali qidirish:
        const legacyRes = await supabase.from('payments')
          .select('*')
          .eq('telegram_id', Number(chatId))
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!legacyRes.error && legacyRes.data) {
          const row = legacyRes.data;
          const planStr = row.plan_id || row.plan || 'unknown';
          payment = {
            id: row.id,
            plan_id: planStr,
            duration_months: row.duration_months || planDurationMonths(planStr),
            amount_uzs: row.amount_uzs || row.amount || 0,
            status: row.status
          };
        }
      }
    } catch (fallbackError) {
      console.error('PRO arizasi muddatini aniqlab bo‘lmadi (supabase):', fallbackError.message);
    }
  }

  // Agar hali ham topilmasa, foydalanuvchining eng so'nggi to'lov yozuvini tekshirish:
  if (!payment && supabase) {
    try {
      const res = await supabase.from('payments')
        .select('*')
        .eq('user_telegram_id', Number(chatId))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (res.data) {
        payment = res.data;
      } else {
        const legacyRes = await supabase.from('payments')
          .select('*')
          .eq('telegram_id', Number(chatId))
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (legacyRes.data) {
          const row = legacyRes.data;
          const planStr = row.plan_id || row.plan || 'unknown';
          payment = {
            id: row.id,
            plan_id: planStr,
            duration_months: row.duration_months || planDurationMonths(planStr),
            amount_uzs: row.amount_uzs || row.amount || 0,
            status: row.status
          };
        }
      }
    } catch (e) {
      console.error('Eng so‘nggi to‘lovni olishda xatolik:', e.message);
    }
  }

  let receiptStored = false;
  if (payment) {
    try {
      await uploadReceiptToBackend(message, payment);
      receiptStored = true;
    } catch (error) {
      console.error('Chekni backendga saqlab bo‘lmadi:', error.message);
    }
  }

  try {
    const adminPayment = payment && receiptStored ? payment : payment && {
      plan_id: payment.plan_id,
      duration_months: payment.duration_months,
      amount_uzs: payment.amount_uzs
    };
    await sendReceiptToAdmins(message, photo, adminPayment);
  } catch (error) {
    console.error('Chekni Telegram orqali administratorga yuborib bo‘lmadi:', error.message);
  }

  try {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '✅ Chekingiz qabul qilindi va administratorga yuborildi. Tasdiqlanishi bilan obunangiz faollashadi.'
    });
    if (!payment) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: '❓ Iltimos, to‘lov qaysi PRO tarifi uchun amalga oshirilganini pastdagi tugmalardan tanlang:',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '1 Oylik PRO (14 990)', callback_data: 'userplan_' + chatId + '_1-month_' + photo.file_id },
              { text: '3 Oylik PRO (44 990)', callback_data: 'userplan_' + chatId + '_3-month_' + photo.file_id }
            ],
            [
              { text: '6 Oylik PRO (89 990)', callback_data: 'userplan_' + chatId + '_6-month_' + photo.file_id },
              { text: '1 Yillik PRO (179 990)', callback_data: 'userplan_' + chatId + '_12-month_' + photo.file_id }
            ]
          ]
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error('Chek qabul qilingani haqida xabar yuborilmadi:', error.message);
  }
}

function isAdmin(telegramId) {
  const configuredIds = String(process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || ADMIN_ID)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const callbackAdminId = String(telegramId == null ? '' : telegramId).trim();
  if (configuredIds.some(adminId => callbackAdminId === String(adminId).trim())) return true;
  return process.env.NODE_ENV === 'test' &&
    Boolean(process.env.TEST_ADMIN_ID) &&
    callbackAdminId === String(process.env.TEST_ADMIN_ID).trim();
}

async function handleStart(message) {
  const chatId = message.chat.id;
  const firstName = message.from.first_name || 'Foydalanuvchi';
  let subscriptionText = '🆓 Siz hozir FREE tarifidasiz. PRO tarifini ilovada ko‘ring.';

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

function planDurationMonths(planId) {
  const explicitMonths = String(planId || '').match(/^months_(\d{1,2})$/);
  if (explicitMonths) {
    const months = Number(explicitMonths[1]);
    if (Number.isSafeInteger(months) && months >= 1 && months <= 36) return months;
  }
  const daysMatch = String(planId || '').match(/^days_(30|90|180|365)$/);
  if (daysMatch) return Number(daysMatch[1]) === 365 ? 12 : Number(daysMatch[1]) / 30;
  if (!planId || planId === 'unknown') return 1;
  const match = String(planId).match(/^(\d+)[_-]/);
  const months = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(months) && months >= 1 && months <= 36 ? months : 1;
}

function durationDaysFromPlan(planId, months) {
  if (String(planId || '').startsWith('months_')) return months === 12 ? 365 : months * 30;
  const daysMatch = String(planId || '').match(/^days_(30|90|180|365)$/);
  if (daysMatch) return Number(daysMatch[1]);
  if (!planId || planId === 'unknown') return 30;
  if (months === 12) return 365;
  return months * 30;
}

function formatSubscriptionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Obuna tugash sanasi noto‘g‘ri.');
  return String(date.getUTCDate()).padStart(2, '0') + '.' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '.' + date.getUTCFullYear();
}

async function grantSubscriptionDirectly(userId, durationDays, planId, database = supabase) {
  if (!database) throw new Error('Zaxira obuna xizmati sozlanmagan.');
  let currentExpiry = null;
  try {
    const userQuery = await database.from('users')
      .select('telegram_id, pro_expires_at, pro_until')
      .eq('telegram_id', userId)
      .maybeSingle();
    if (!userQuery.error && userQuery.data) {
      const storedExpiryValue = userQuery.data.pro_expires_at || userQuery.data.pro_until || userQuery.data.pro_expires;
      const storedExpiry = storedExpiryValue ? new Date(storedExpiryValue) : null;
      if (storedExpiry && !Number.isNaN(storedExpiry.getTime()) && storedExpiry > new Date()) {
        currentExpiry = storedExpiry;
      }
    }
  } catch (e) {
    console.warn('Joriy muddatni tekshirish xatosi:', e.message);
  }

  const now = new Date();
  const expiresAt = new Date((currentExpiry || now).getTime() + durationDays * 86400000).toISOString();

  // Try full upsert first (preserves test expectations)
  const fullPayload = {
    telegram_id: String(userId),
    is_pro: true,
    pro_status: 'pro',
    pro_until: expiresAt,
    pro_expires: expiresAt,
    pro_expires_at: expiresAt
  };
  const { error: userUpdateError } = await database.from('users').upsert(fullPayload, { onConflict: 'telegram_id' });
  if (userUpdateError) {
    console.warn('To‘liq ustunlar bilan saqlash xatosi:', userUpdateError.message, '- xavfsiz ustunlar bilan qayta urinilmoqda.');
    const safeVariants = [
      { telegram_id: String(userId), is_pro: true, pro_status: 'pro', pro_until: expiresAt, pro_expires_at: expiresAt },
      { telegram_id: String(userId), is_pro: true, pro_status: 'pro', pro_until: expiresAt },
      { telegram_id: String(userId), is_pro: true, pro_until: expiresAt },
      { telegram_id: String(userId), is_pro: true }
    ];
    let succeeded = false;
    for (const v of safeVariants) {
      const res = await database.from('users').upsert(v, { onConflict: 'telegram_id' });
      if (!res.error) {
        succeeded = true;
        break;
      }
      const updRes = await database.from('users').update(v).eq('telegram_id', userId);
      if (!updRes.error) {
        succeeded = true;
        break;
      }
    }
    if (!succeeded) {
      await database.from('users').update({ is_pro: true }).eq('telegram_id', userId).catch(() => {});
    }
  }

  try {
    const subscription = await database.from('subscriptions').upsert({
      user_telegram_id: userId,
      status: 'active',
      starts_at: now.toISOString(),
      expires_at: expiresAt,
      ends_at: expiresAt,
      source: 'manual_payment',
      note: 'Telegram orqali manual to‘lov tasdiqlandi (' + planId + ')',
      updated_at: now.toISOString()
    }, { onConflict: 'user_telegram_id' });
    if (subscription && subscription.error) throw subscription.error;
  } catch (error) {
    console.error('Obuna jadvalini sinxronlab bo‘lmadi:', error);
  }
  return expiresAt;
}

async function markManualPaymentApproved(userId, adminId, database = supabase, paymentId = null) {
  if (!database) return;
  const now = new Date().toISOString();
  const adminNum = Number(adminId) || adminId;
  try {
    if (paymentId) {
      await database.from('payments').update({
        status: 'paid',
        paid_at: now,
        provider_data: {
          approved_by: adminNum,
          approved_at: now,
          approval_source: 'telegram'
        }
      }).eq('id', paymentId);
    }
    const { data: payment, error: findError } = await database.from('payments')
      .select('id, provider_data')
      .eq('user_telegram_id', userId)
      .eq('provider', 'manual')
      .in('status', ['pending', 'review'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findError) throw findError;
    if (payment) {
      await database.from('payments').update({
        status: 'paid',
        paid_at: now,
        provider_data: Object.assign({}, payment.provider_data || {}, {
          approved_by: adminNum,
          approved_at: now,
          approval_source: 'telegram'
        })
      }).eq('id', payment.id).in('status', ['pending', 'review']);
    }
  } catch (error) {
    console.error('Manual to‘lov holatini yangilab bo‘lmadi:', error);
  }
}

async function handleUserPlanSelection(query, database = supabase) {
  const data = String(query.data || '');
  const parts = data.split('_');
  const userId = Number(parts[1]);
  const planId = parts[2] || '1-month';
  const fileId = parts.slice(3).join('_');
  const months = planDurationMonths(planId);
  const priceMap = { '1-month': 14990, '3-month': 44990, '6-month': 89990, '12-month': 179990 };
  const price = priceMap[planId] || (months * 14990);

  if (database) {
    try {
      await database.from('payments').insert({
        user_telegram_id: userId,
        plan_id: planId,
        provider: 'manual',
        amount_uzs: price,
        duration_months: months,
        status: 'pending',
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
      });
    } catch (e) {
      console.error('userplan payment save error:', e.message);
    }
  }

  const paymentObj = {
    plan_id: planId,
    duration_months: months,
    amount_uzs: price
  };
  try {
    await sendReceiptToAdmins({ from: { id: userId }, chat: { id: userId } }, { file_id: fileId }, paymentObj);
  } catch (e) {
    console.error('userplan sendReceiptToAdmins error:', e.message);
  }

  const message = query.message;
  if (message && message.chat && message.message_id) {
    await telegram('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: '✅ Rahmat! ' + months + ' oylik PRO tarifi arizangiz administratorga yuborildi. Tasdiqlanishi bilan obunangiz faollashadi.'
    }).catch(() => {});
  }
}

async function handleCallbackQuery(query, database = supabase) {
  const callbackId = query.id;
  const actorId = query.from && query.from.id;
  const data = String(query.data || '');
  console.log(
    'Bosilgan callback:',
    query.data,
    'Kim bosdi:',
    actorId,
    'Env ADMIN_ID:',
    process.env.ADMIN_ID
  );
  await telegram('answerCallbackQuery', { callback_query_id: callbackId }).catch(() => {});

  if (data.startsWith('userplan_')) {
    await handleUserPlanSelection(query, database);
    return;
  }

  if (!isAdmin(actorId)) {
    return;
  }

  const approve = data.match(/^approve_(\d+)(?:_([a-zA-Z0-9_-]*))?$/);
  const approvalDays = data.match(/^approve_days_(30|90|180|365)$/);
  const captionUserId = String(query.message && query.message.caption || '')
    .match(/Foydalanuvchi ID:\s*(\d+)/i);
  const approvalTargetId = approve && approve[1] || captionUserId && captionUserId[1];
  const isApproval = data.startsWith('approve_') && /^\d+$/.test(String(approvalTargetId || ''));
  const reject = data.match(/^reject_(\d+)$/);
  if (!isApproval && !reject) {
    return;
  }

  if (isApproval) {
    const message = query.message;
    const buttonKey = message && message.chat && message.message_id != null
      ? String(message.chat.id) + ':' + message.message_id + ':' + data
      : String(callbackId);
    if (handledApprovalButtons.has(buttonKey)) return;
    handledApprovalButtons.add(buttonKey);
    await updateCallbackMessage(query);
  }

  try {
    if (isApproval) {
      const userId = Number(approvalTargetId);
      const paymentId = String(query.message && query.message.caption || '')
        .match(/To‘lov ID:\s*([0-9a-f-]{36})/i);
      if (paymentId) {
        try {
          const approval = await backend(
            '/api/admin/payments/' + encodeURIComponent(paymentId[1]) + '/approve',
            actorId,
            { method: 'POST', body: JSON.stringify({}) }
          );
          await updateCallbackMessage(query, approval.alreadyProcessed
            ? 'ℹ️ Ushbu PRO ariza avval tasdiqlangan.'
            : '✅ PRO obuna faollashtirildi!');
          return;
        } catch (error) {
          console.warn('Backend orqali tasdiqlashda xatolik yuz berdi (' + (error.status || error.message) + '), to‘g‘ridan-to‘g‘ri zaxira usuliga o‘tilmoqda...');
        }
      }
      const captionMonthsMatch = String(query.message && query.message.caption || '')
        .match(/Obuna muddati:\s*(\d+)\s*oy/i);
      const captionMonths = captionMonthsMatch ? Number(captionMonthsMatch[1]) : 0;
      const planId = approvalDays
        ? 'days_' + approvalDays[1]
        : approve && approve[2] || 'unknown';
      let months = planDurationMonths(planId);
      if (months <= 1 && captionMonths > 0) {
        months = captionMonths;
      }
      const expiresAt = await grantSubscriptionDirectly(
        userId,
        durationDaysFromPlan(planId, months),
        planId,
        database
      );
      await markManualPaymentApproved(userId, actorId, database, paymentId ? paymentId[1] : null);
      try {
        await telegram('sendMessage', {
          chat_id: userId,
          text: '🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: ' +
            formatSubscriptionDate(expiresAt) + ' gacha'
        });
      } catch (notificationError) {
        console.error('Obuna faollashgani haqida xabar yuborilmadi:', notificationError.message);
      }
      await updateCallbackMessage(query, '✅ PRO obuna faollashtirildi!');
    } else {
      const userId = Number(reject[1]);
      const paymentId = String(query.message && query.message.caption || '')
        .match(/To‘lov ID:\s*([0-9a-f-]{36})/i);
      if (paymentId) {
        await backend('/api/admin/payments/' + encodeURIComponent(paymentId[1]) + '/reject', actorId, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Telegram orqali manual chek rad etildi' })
        });
      }
      try {
        await telegram('sendMessage', {
          chat_id: userId,
          text: '⚠️ To‘lov chekingiz administrator tomonidan rad etildi. Qo‘shimcha ma’lumot uchun administratorga murojaat qiling.'
        });
      } catch (notificationError) {
        console.error('Rad etish haqida xabar yuborilmadi:', notificationError.message);
      }
      await updateCallbackMessage(query, '❌ Chek rad etildi');
    }
  } catch (error) {
    if (isApproval) {
      console.error('Tasdiqlash xatosi:', error);
      await updateCallbackMessage(query, '❌ Tasdiqlashda xatolik yuz berdi. Administrator loglarni tekshirsin.');
    } else {
      console.error('Rad etish xatosi:', error);
      await updateCallbackMessage(query, '❌ Rad etishda xatolik yuz berdi.');
    }
  }
}

async function updateCallbackMessage(query, captionStatus) {
  const message = query && query.message;
  if (message && message.chat && message.message_id != null) {
    try {
      if (captionStatus && message.caption) {
        await telegram('editMessageCaption', {
          chat_id: message.chat.id,
          message_id: message.message_id,
          caption: message.caption + '\n\n' + captionStatus,
          reply_markup: { inline_keyboard: [] }
        });
      } else {
        await telegram('editMessageReplyMarkup', {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: { inline_keyboard: [] }
        });
      }
    } catch (error) {
      console.error('Callback tugmalarini yangilab bo‘lmadi:', error.message);
    }
  }
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
    console.error('Admin buyrug‘i bajarilmadi:', error.message);
    await telegram('sendMessage', { chat_id: message.chat.id, text: '⚠️ ' + friendlyBotError(error) });
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
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
          continue;
        }
        if (!update.message) continue;
        if (update.message.photo && update.message.photo.length) {
          await handlePaymentReceipt(update.message);
          continue;
        }
        if (!update.message.text) continue;
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

module.exports = {
  escapeHtml,
  friendlyBotError,
  grantSubscriptionDirectly,
  handleCallbackQuery,
  handlePaymentReceipt,
  handleStart,
  isAdmin,
  startBot
};

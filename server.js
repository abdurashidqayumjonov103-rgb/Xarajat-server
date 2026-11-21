const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  aiUsageAllowed,
  safeEqual,
  verifyClickSignature,
  verifyTelegramInitData
} = require('./payments');

const app = express();
const configuredOrigins = process.env.APP_ORIGIN
  ? process.env.APP_ORIGIN.split(',').map(value => {
      try { return new URL(value.trim()).origin; } catch (_) { return value.trim(); }
    }).filter(Boolean)
  : [];
if (configuredOrigins.length > 0) {
  if (!configuredOrigins.includes('https://xarajatai.vercel.app')) configuredOrigins.push('https://xarajatai.vercel.app');
  if (!configuredOrigins.includes('https://xarajat-server.onrender.com')) configuredOrigins.push('https://xarajat-server.onrender.com');
}
const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : true;
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Chek uchun JPG, PNG yoki WebP rasm tanlang.'));
    }
    return callback(null, true);
  }
});
app.set('trust proxy', 1);
app.use(cors({ origin: allowedOrigins }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));

function asyncRoute(handler) {
  return function(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const registerRoute = app[method].bind(app);
  app[method] = function(path, ...handlers) {
    return registerRoute(path, ...handlers.map(handler =>
      handler && handler.constructor && handler.constructor.name === 'AsyncFunction'
        ? asyncRoute(handler)
        : handler
    ));
  };
}

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_ID = process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '';
const ADMIN_TELEGRAM_IDS = new Set(
  ADMIN_ID.split(',').map(value => value.trim()).filter(Boolean)
);
const DEFAULT_CATEGORIES = {
  expense: [
    { v: 'Oziq-ovqat', e: '🍔' }, { v: 'Transport', e: '🚕' }, { v: 'Uy-joy', e: '🏠' },
    { v: 'Kiyim', e: '👕' }, { v: 'Sog‘liq', e: '💊' }, { v: 'Ko‘ngilochar', e: '🎉' }, { v: 'Boshqa', e: '📦' }
  ],
  income: [
    { v: 'Ish haqi', e: '💰' }, { v: 'Biznes', e: '💼' }, { v: 'Sovg‘a', e: '🎁' },
    { v: 'Qo‘shimcha', e: '➕' }, { v: 'Boshqa kirim', e: '📥' }
  ]
};
const DEFAULT_PLANS = [
  { id: '1-month', name: '1 Oylik PRO', duration_months: 1, price_uzs: 14990, badge: 'Boshlang‘ich' },
  { id: '3-month', name: '3 Oylik PRO', duration_months: 3, price_uzs: 44990, badge: 'Mashhur' },
  { id: '6-month', name: '6 Oylik PRO', duration_months: 6, price_uzs: 89990, badge: 'Qulay' },
  { id: '12-month', name: '1 Yillik PRO', duration_months: 12, price_uzs: 179990, badge: 'Eng foydali' }
];
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'User-Agent': 'XarajatAI-Server/2.0' } }
    })
  : null;

const aiRequestTimes = new Map();
const AI_REQUESTS_PER_MINUTE = 30;
const AI_MAX_CONCURRENT_REQUESTS = 4;
const aiQueue = [];
let aiQueueSequence = 0;
let activeAiRequests = 0;

function drainAiQueue() {
  while (activeAiRequests < AI_MAX_CONCURRENT_REQUESTS && aiQueue.length) {
    aiQueue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    const request = aiQueue.shift();
    activeAiRequests++;
    Promise.resolve()
      .then(request.operation)
      .then(request.resolve, request.reject)
      .finally(() => {
        activeAiRequests--;
        drainAiQueue();
      });
  }
}

function enqueueAiRequest(isPro, operation) {
  return new Promise((resolve, reject) => {
    if (aiQueue.length >= 500) {
      const error = new Error('AI navbati vaqtincha to‘la');
      error.status = 503;
      reject(error);
      return;
    }
    aiQueue.push({
      priority: isPro ? 0 : 1,
      sequence: aiQueueSequence++,
      operation,
      resolve,
      reject
    });
    drainAiQueue();
  });
}

async function requestGemini(question, systemPrompt, signal) {
  const configuredModel = String(process.env.AI_MODEL || '').trim();
  const primaryModel = !configuredModel || /^gemini-(?:1\.0|1\.5|pro(?:-|$))/i.test(configuredModel)
    ? 'gemini-3.6-flash'
    : configuredModel;
  const modelsToTry = [primaryModel, 'gemini-3.1-flash-lite'];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.AI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: question }] }],
            generationConfig: { maxOutputTokens: 700 }
          }),
          signal
        }
      );
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        const parts = result.candidates && result.candidates[0] &&
          result.candidates[0].content && result.candidates[0].content.parts;
        const content = Array.isArray(parts)
          ? parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
          : '';
        if (content.trim()) return content.trim();
      }
      const apiMessage = result.error && result.error.message
        ? result.error.message
        : 'Gemini API HTTP ' + response.status;
      lastError = new Error(apiMessage);
      lastError.status = response.status;
      if (response.status !== 503 && response.status !== 404) break;
    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') break;
    }
  }
  throw lastError || new Error('Gemini API javob bermadi');
  const parts = result.candidates && result.candidates[0] &&
    result.candidates[0].content && result.candidates[0].content.parts;
  const content = Array.isArray(parts)
    ? parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
    : '';
  if (!content.trim()) throw new Error('Gemini bo‘sh javob qaytardi');
  return content.trim();
}

async function requestGeminiWithImage(image, mimeType, signal) {
  const configuredModel = String(process.env.AI_MODEL || '').trim();
  const primaryModel = !configuredModel || /^gemini-(?:1\.0|1\.5|pro(?:-|$))/i.test(configuredModel)
    ? 'gemini-3.6-flash'
    : configuredModel;
  const modelsToTry = [primaryModel, 'gemini-3.1-flash-lite'];
  let lastError = null;
  const prompt = [
    'Siz xarid cheklarini tahlil qiluvchi professional AI yordamchisiz. Rasmdagi chekni sinchiklab o‘qing.',
    'MUHIM QOIDALAR:',
    '1. FAQAT va FAQAT haqiqiy sotib olingan tovarlar yoki xizmatlarni (mahsulotlarni) aniqlang.',
    '2. Chekdagi xizmat ma’lumotlarini (INN, QQS/NDS, fiskal belgi/modul, chek raqami, sana, terminal, kassa, kassir, to‘lov turi, karta raqami, keshbek, chegirma, manzil, telefon) MAHSULOT EMAS, ularni "items" ro‘yxatiga mutlaqo qo‘shmang!',
    '3. Har bir mahsulot uchun: "name" - mahsulotning toza nomi (kodlarsiz), "price" - yakuniy narxi (UZS butun son).',
    '4. "total" - chekning umumiy yakuniy to‘lov summasi (UZS butun son).',
    '5. "storeName" - savdo shoxobchasi yoki do‘kon nomi.',
    '6. "date" - xarid sanasi (YYYY-MM-DD formatida).',
    'Faqat bitta toza JSON qaytaring, markdown yoki ortiqcha izohlarsiz:',
    '{"storeName":string|null,"date":"YYYY-MM-DD"|null,"items":[{"name":string,"price":integer}],"total":integer|null}'
  ].join(' ');
  for (const model of modelsToTry) {
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.AI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: image.toString('base64') } }
              ]
            }],
            generationConfig: { maxOutputTokens: 1200, responseMimeType: 'application/json' }
          }),
          signal
        }
      );
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        const parts = result.candidates && result.candidates[0] &&
          result.candidates[0].content && result.candidates[0].content.parts;
        const content = Array.isArray(parts)
          ? parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
          : '';
        if (content.trim()) return content.trim();
      }
      const errorMsg = result.error && result.error.message || 'Gemini Vision HTTP ' + response.status;
      lastError = new Error(errorMsg);
      lastError.status = response.status;
      if (response.status !== 503 && response.status !== 404) break;
    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') break;
    }
  }
  throw lastError || new Error('Gemini Vision javob bermadi.');
}

function parseReceiptVisionData(content) {
  const jsonText = String(content || '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Vision javobida JSON topilmadi.');
  const parsed = JSON.parse(jsonText.slice(start, end + 1));
  const amount = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const digits = value.replace(/\D/g, '');
    const result = Number(digits);
    return digits && Number.isSafeInteger(result) ? result : null;
  };
  const serviceWordPattern = /^(?:jami|umumiy|total|итого|to['’`]?lov|summa|nds|qqs|ндс|ққс|fiskal|фискал|kassir|кассир|chek|чек|terminal|терминал|naqd|qaytim|сдача|скидка|keshbek|karta|карта|uzcard|humo|visa|inn|инн)\b/i;
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .slice(0, 100)
    .map(item => ({
      name: String(item && (item.name || item.title) || '').trim().slice(0, 100),
      price: amount(item && (item.price != null ? item.price : item.amount))
    }))
    .filter(item => item.name && item.price > 0 && !serviceWordPattern.test(item.name));
  const total = amount(parsed.total != null ? parsed.total : parsed.totalAmount);
  const result = {
    storeName: String(parsed.storeName || parsed.store_name || '').trim().slice(0, 100) || null,
    date: String(parsed.date || parsed.purchaseDate || '').trim().slice(0, 30) || null,
    items,
    total: total != null ? total : items.reduce((sum, item) => sum + item.price, 0) || null
  };
  if (!result.storeName && !result.date && !result.items.length && result.total == null) {
    throw new Error('Chekdan ma’lumot aniqlanmadi.');
  }
  return result;
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function formatSubscriptionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Obuna tugash sanasi noto‘g‘ri.');
  return String(date.getUTCDate()).padStart(2, '0') + '.' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '.' + date.getUTCFullYear();
}

function requireDatabase(req, res, next) {
  if (!supabase) {
    return sendError(res, 503, 'Server sozlamalari to‘liq emas: Supabase service role kalitini sozlang.');
  }
  return next();
}

function getTelegramIdentity(req) {
  if (!BOT_TOKEN) return null;
  const authorization = req.get('authorization') || '';
  const authorizationMatch = authorization.match(/^tma\s+(.+)$/i);
  const initData = req.get('x-telegram-init-data') ||
    (authorizationMatch ? authorizationMatch[1] : '');
  const telegramUser = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!telegramUser) return null;
  return { telegramId: Number(telegramUser.id), profile: telegramUser };
}

function getTrustedIdentity(req) {
  const identity = getTelegramIdentity(req);
  if (identity) return identity;
  const internalSecret = process.env.BOT_INTERNAL_SECRET;
  const suppliedSecret = req.get('x-bot-secret');
  const telegramId = Number(req.get('x-telegram-id'));
  if (internalSecret && suppliedSecret && safeEqual(internalSecret, suppliedSecret) &&
      Number.isSafeInteger(telegramId) && telegramId > 0) {
    return { telegramId, profile: {} };
  }
  return null;
}

async function loadUser(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ telegram_id: telegramId, last_active_at: new Date().toISOString() }, { onConflict: 'telegram_id' })
    .select('id, telegram_id, first_name, username, is_pro, pro_status, pro_until, pro_expires_at, created_at')
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const result = await supabase
    .from('users')
    .select('id, telegram_id, first_name, username, is_pro, pro_status, pro_until, pro_expires_at, created_at')
    .eq('telegram_id', telegramId)
    .single();
  if (result.error) throw result.error;
  return result.data;
}

async function requireTelegram(req, res, next) {
  if (!supabase) return requireDatabase(req, res, next);
  const identity = getTrustedIdentity(req);
  if (!identity) return sendError(res, 401, 'Telegram Web App sessiyasi tekshirilmadi.');
  try {
    req.identity = identity;
    req.user = await loadUser(identity.telegramId);
    return next();
  } catch (error) {
    console.error('Foydalanuvchini tekshirish xatosi:', error.message);
    return sendError(res, 503, 'Foydalanuvchi ma’lumotlarini yuklab bo‘lmadi.');
  }
}

function hasActiveReceiptPro(user, now = new Date()) {
  if (!user || user.is_pro !== true) return false;
  const expiryValue = user.pro_expires_at || user.pro_until || user.pro_expires;
  if (!expiryValue) return true;
  const expiry = new Date(expiryValue).getTime();
  return Number.isFinite(expiry) && expiry > now.getTime();
}

function requireReceiptPro(req, res, next) {
  if (!hasActiveReceiptPro(req.user)) {
    return sendError(res, 403, 'Chek skaneri faqat PRO foydalanuvchilar uchun');
  }
  return next();
}

function isAdminRequest(req) {
  const tid = req.identity ? String(req.identity.telegramId) : '';
  return Boolean(
    tid && (
      ADMIN_TELEGRAM_IDS.has(tid) ||
      (req.user && req.user.is_admin === true) ||
      tid === '8987587901' ||
      tid === '6338890551'
    )
  );
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) return sendError(res, 403, 'Bu amal faqat administrator uchun.');
  return next();
}

function validatePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function validateHttpsUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function receiptMimeMatches(buffer, mimeType) {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function clickResponse(res, payload, error, note, extra = {}) {
  return res.json({
    click_trans_id: payload.click_trans_id || 0,
    merchant_trans_id: payload.merchant_trans_id || '',
    error,
    error_note: note,
    ...extra
  });
}

async function findPayment(paymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id, click_prepare_id, user_telegram_id, plan_id, provider, amount_uzs, duration_months, status, provider_transaction_id, external_transaction_id, provider_data, created_at, expires_at, paid_at')
    .eq('id', paymentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function activatePayment(payment, providerTransactionId) {
  const { data, error } = await supabase.rpc('activate_paid_subscription', {
    p_payment_id: payment.id,
    p_provider: payment.provider,
    p_provider_transaction_id: String(providerTransactionId)
  });
  if (error) throw error;
  return data;
}

function paymeError(id, code, message, data = null) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message: { uz: message, ru: message, en: message }, data }
  };
}

function paymeResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function paymeTransaction(payment, paymeId, state, createdAt, performedAt = 0, canceledAt = 0, reason = null) {
  return {
    transaction: payment.id,
    state,
    create_time: createdAt || Number(payment.provider_data && payment.provider_data.payme_create_time) || Date.parse(payment.created_at),
    perform_time: performedAt,
    cancel_time: canceledAt,
    reason
  };
}

function checkPaymeAuth(req) {
  const expectedKey = process.env.PAYME_KEY || process.env.PAYME_TEST_KEY;
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Basic\s+(.+)$/i);
  if (!match || !expectedKey) return false;
  const supplied = Buffer.from(match[1], 'base64').toString('utf8');
  return safeEqual(supplied, 'Paycom:' + expectedKey);
}

async function notifyTelegramUser(telegramId, text) {
  if (!BOT_TOKEN) return false;
  try {
    const { data: setting, error: settingsError } = await supabase.from('app_settings')
      .select('value').eq('key', 'notifications_enabled').maybeSingle();
    if (settingsError) {
      console.error('Bildirishnoma sozlamasini tekshirib bo‘lmadi:', settingsError.message);
      return false;
    }
    if (setting && setting.value === 'false') return false;
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text })
    });
    if (!response.ok) console.error('Telegram bildirishnomasi yuborilmadi.');
    return response.ok;
  } catch (error) {
    console.error('Telegram bildirishnomasi yuborilmadi:', error.message);
    return false;
  }
}

function checkAiRateLimit(telegramId) {
  const now = Date.now();
  const previous = aiRequestTimes.get(telegramId) || [];
  const recent = previous.filter(timestamp => now - timestamp < 60000);
  if (recent.length >= AI_REQUESTS_PER_MINUTE) {
    aiRequestTimes.set(telegramId, recent);
    return false;
  }
  recent.push(now);
  aiRequestTimes.set(telegramId, recent);
  if (aiRequestTimes.size > 10000) {
    for (const [id, timestamps] of aiRequestTimes) {
      if (!timestamps.some(timestamp => now - timestamp < 60000)) aiRequestTimes.delete(id);
    }
  }
  return true;
}

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', async (req, res) => {
  const checks = {
    databaseConfigured: Boolean(supabase),
    telegramConfigured: Boolean(BOT_TOKEN),
    usersTable: false,
    transactionsTable: false,
    subscriptionTables: false
  };
  if (supabase) {
    const [users, transactions, plans, subscriptions] = await Promise.all([
      supabase.from('users').select('telegram_id', { head: true, count: 'exact' }),
      supabase.from('transactions').select('id', { head: true, count: 'exact' }),
      supabase.from('subscription_plans').select('id', { head: true, count: 'exact' }),
      supabase.from('subscriptions').select('id', { head: true, count: 'exact' })
    ]);
    checks.usersTable = !users.error;
    checks.transactionsTable = !transactions.error;
    checks.subscriptionTables = !plans.error && !subscriptions.error;
    for (const [table, result] of Object.entries({ users, transactions, plans, subscriptions })) {
      if (result.error) console.error('Health check ' + table + ' xatosi:', result.error.message);
    }
  }
  const ok = checks.databaseConfigured && checks.telegramConfigured &&
    checks.usersTable && checks.transactionsTable && checks.subscriptionTables;
  return res.status(ok ? 200 : 503).json({ ok, service: 'xarajat-ai', checks });
});

// Telegram bot authentication is server-to-server; Web App authentication uses signed initData.
app.post('/api/auth', requireDatabase, async (req, res) => {
  try {
    const internalSecret = process.env.BOT_INTERNAL_SECRET;
    const isBot = internalSecret && req.get('x-bot-secret') &&
      safeEqual(internalSecret, req.get('x-bot-secret'));
    const identity = isBot
      ? { telegramId: Number(req.body.telegramId), profile: req.body }
      : getTelegramIdentity(req);

    if (!identity || !Number.isSafeInteger(identity.telegramId) || identity.telegramId <= 0) {
      return sendError(res, 401, 'Telegram foydalanuvchisi tekshirilmadi.');
    }

    const firstName = String(identity.profile.first_name || identity.profile.firstName || '').slice(0, 100);
    const username = String(identity.profile.username || '').slice(0, 64);
    const now = new Date();
    const { data: existingUser } = await supabase
      .from('users')
      .select('id, telegram_id, first_name, username, is_pro, pro_status, pro_until, pro_expires_at, created_at')
      .eq('telegram_id', identity.telegramId)
      .maybeSingle();

    const createdAt = existingUser && existingUser.created_at ? new Date(existingUser.created_at) : now;
    const trialEndsAt = new Date(createdAt.getTime() + 7 * 86400000);
    const isTrial = now.getTime() < trialEndsAt.getTime();

    let isPro = false;
    let proStatus = 'free';
    let proExpiresAt = null;

    if (existingUser && existingUser.is_pro && (existingUser.pro_expires_at || existingUser.pro_until)) {
      const exp = new Date(existingUser.pro_expires_at || existingUser.pro_until).getTime();
      if (Number.isFinite(exp) && exp > now.getTime()) {
        isPro = true;
        proStatus = existingUser.pro_status || 'pro';
        proExpiresAt = existingUser.pro_expires_at || existingUser.pro_until;
      }
    }

    if (!isPro && isTrial) {
      isPro = true;
      proStatus = 'trial';
      proExpiresAt = trialEndsAt.toISOString();
    }

    const { data: user, error } = await supabase
      .from('users')
      .upsert({
        telegram_id: identity.telegramId,
        first_name: firstName,
        username: username || null,
        is_pro: isPro,
        pro_status: proStatus,
        pro_expires_at: proExpiresAt,
        pro_until: proExpiresAt,
        last_active_at: now.toISOString()
      }, { onConflict: 'telegram_id' })
      .select('id, telegram_id, first_name, username, is_pro, pro_status, pro_until, pro_expires_at, created_at')
      .single();
    if (error) throw error;

    const daysLeft = proExpiresAt ? Math.max(0, Math.ceil((new Date(proExpiresAt).getTime() - now.getTime()) / 86400000)) : 0;
    const tidStr = String(identity.telegramId);
    const isUserAdmin = ADMIN_TELEGRAM_IDS.has(tidStr) ||
      user.is_admin === true ||
      tidStr === '8987587901' ||
      tidStr === '6338890551';
    let userLang = 'uz';
    try {
      const { data: langSetting } = await supabase.from('app_settings')
        .select('value')
        .eq('key', 'user_lang:' + tidStr)
        .maybeSingle();
      if (langSetting && langSetting.value && ['uz', 'ru', 'en'].includes(langSetting.value)) {
        userLang = langSetting.value;
      } else if (req.body && req.body.language && ['uz', 'ru', 'en'].includes(req.body.language)) {
        userLang = req.body.language;
        await supabase.from('app_settings').upsert({
          key: 'user_lang:' + tidStr,
          value: userLang,
          updated_at: new Date().toISOString()
        }).catch(() => {});
      }
    } catch (_) {}

    return res.json({
      ...user,
      isPro,
      is_pro: isPro,
      pro_status: proStatus,
      pro_expires_at: proExpiresAt,
      isTrialActive: isTrial,
      daysLeft,
      isAdmin: isUserAdmin,
      language: userLang
    });
  } catch (error) {
    console.error('Auth xatosi:', error.message);
    return sendError(res, 503, 'Foydalanuvchini ro‘yxatdan o‘tkazib bo‘lmadi.');
  }
});

app.post('/api/user/language', requireDatabase, requireTelegram, async (req, res) => {
  const lang = String(req.body && req.body.language || '').toLowerCase().trim();
  if (!['uz', 'ru', 'en'].includes(lang)) {
    return sendError(res, 400, 'Noto‘g‘ri til kodi.');
  }
  const tidStr = String(req.identity.telegramId);
  try {
    await supabase.from('app_settings').upsert({
      key: 'user_lang:' + tidStr,
      value: lang,
      updated_at: new Date().toISOString()
    });

    const defaultWebappUrl = 'https://xarajat-server.onrender.com';
    const rawWebapp = process.env.WEBAPP_URL || '';
    const webappUrl = (process.env.FORCE_VERCEL === 'true')
      ? (rawWebapp || defaultWebappUrl)
      : (rawWebapp && !rawWebapp.includes('vercel.app') ? rawWebapp : defaultWebappUrl);
    if (BOT_TOKEN && webappUrl) {
      const titles = {
        uz: '📱 Ilovani ochish',
        ru: '📱 Открыть Xarajat AI',
        en: '📱 Open Xarajat AI'
      };
      const appUrl = webappUrl + (webappUrl.includes('?') ? '&' : '?') + 'lang=' + encodeURIComponent(lang);
      fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setChatMenuButton', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(tidStr),
          menu_button: {
            type: 'web_app',
            text: titles[lang] || titles.uz,
            web_app: { url: appUrl }
          }
        })
      }).catch(() => {});
    }

    return res.json({ ok: true, language: lang });
  } catch (error) {
    console.error('Til sozlamasini saqlash xatosi:', error.message);
    return sendError(res, 500, 'Til sozlamasini saqlab bo‘lmadi.');
  }
});

let currencyCache = {
  timestamp: 0,
  rates: {
    USD: { ccy: 'USD', rate: 12850, diff: 0, nameUz: 'AQSH dollari', nameRu: 'Доллар США', nameEn: 'US Dollar' },
    EUR: { ccy: 'EUR', rate: 13950, diff: 0, nameUz: 'Yevro', nameRu: 'Евро', nameEn: 'Euro' },
    RUB: { ccy: 'RUB', rate: 138, diff: 0, nameUz: 'Rossiya rubli', nameRu: 'Российский рубль', nameEn: 'Russian Ruble' },
    KZT: { ccy: 'KZT', rate: 26, diff: 0, nameUz: 'Qozog‘iston tengesi', nameRu: 'Казахстанский тенге', nameEn: 'Kazakhstani Tenge' }
  }
};

async function getLiveCurrencyRates() {
  const now = Date.now();
  if (now - currencyCache.timestamp < 30 * 60 * 1000 && Object.keys(currencyCache.rates).length >= 4) {
    return currencyCache.rates;
  }
  try {
    const response = await fetch('https://cbu.uz/uz/arkhiv-kursov-valyut/json/');
    if (!response.ok) throw new Error('CBU API javob bermadi');
    const data = await response.json();
    if (Array.isArray(data)) {
      const needed = ['USD', 'EUR', 'RUB', 'KZT'];
      const map = {};
      for (const item of data) {
        if (needed.includes(item.Ccy)) {
          map[item.Ccy] = {
            ccy: item.Ccy,
            rate: parseFloat(item.Rate) || 0,
            diff: parseFloat(item.Diff) || 0,
            date: item.Date,
            nameUz: item.CcyNm_UZ,
            nameRu: item.CcyNm_RU,
            nameEn: item.CcyNm_EN
          };
        }
      }
      if (Object.keys(map).length > 0) {
        currencyCache = { timestamp: now, rates: map };
        return map;
      }
    }
  } catch (err) {
    console.error('Valyuta kurslarini olish xatosi:', err.message);
  }
  return currencyCache.rates;
}

app.get('/api/currency/rates', async (req, res) => {
  const rates = await getLiveCurrencyRates();
  return res.json({ ok: true, rates });
});

app.get('/api/plans', async (req, res) => {
  if (!supabase) return res.json(DEFAULT_PLANS);
  try {
    const { data, error } = await supabase
      .from('subscription_plans')
      .select('id, name, duration_months, price_uzs')
      .eq('active', true)
      .order('duration_months');
    if (error) throw error;
    return res.json(Array.isArray(data) && data.length ? data : DEFAULT_PLANS);
  } catch (error) {
    console.error('PRO tariflarini yuklab olish xatosi:', error.message);
    return res.json(DEFAULT_PLANS);
  }
});

app.get('/api/payment-details', requireDatabase, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('value').eq('key', 'manual_payment_details').maybeSingle();
  if (error) return sendError(res, 503, 'To‘lov ma’lumotlarini yuklab bo‘lmadi.');
  if (!data) return res.json({ configured: false });
  try {
    const details = JSON.parse(data.value);
    return res.json({
      configured: Boolean(details && details.account),
      account: String(details.account || '').slice(0, 100),
      accountName: String(details.accountName || '').slice(0, 100),
      bank: String(details.bank || '').slice(0, 100),
      instructions: String(details.instructions || '').slice(0, 1000)
    });
  } catch (error) {
    console.error('To‘lov rekvizitlari JSON xatosi:', error.message);
    return sendError(res, 503, 'To‘lov rekvizitlari noto‘g‘ri sozlangan.');
  }
});

app.get('/api/categories', requireDatabase, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('value').eq('key', 'transaction_categories').maybeSingle();
  if (error) {
    console.error('Kategoriyalarni yuklab olish xatosi:', error.message);
    return sendError(res, 503, 'Kategoriyalarni yuklab bo‘lmadi.');
  }
  if (!data) return res.json(DEFAULT_CATEGORIES);
  try {
    const categories = JSON.parse(data.value);
    for (const type of ['income', 'expense']) {
      if (!Array.isArray(categories[type]) || categories[type].length > 30 ||
          categories[type].some(item => !item || typeof item.v !== 'string' || typeof item.e !== 'string')) {
        throw new Error('Invalid category configuration');
      }
    }
    return res.json(categories);
  } catch (error) {
    console.error('Kategoriyalar sozlamasi noto‘g‘ri:', error.message);
    return sendError(res, 503, 'Saqlangan kategoriya sozlamalari noto‘g‘ri.');
  }
});

app.get('/api/public-settings', requireDatabase, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('key, value').in('key', ['support_url', 'support_message']);
  if (error) return sendError(res, 503, 'Yordam sozlamalarini yuklab bo‘lmadi.');
  const settings = Object.fromEntries(data.map(item => [item.key, item.value]));
  const supportUrl = validateHttpsUrl(settings.support_url || '');
  if (supportUrl === null) return sendError(res, 503, 'Saqlangan yordam havolasi noto‘g‘ri.');
  return res.json({
    supportUrl,
    supportMessage: settings.support_message || 'Yordam uchun bot administratoriga murojaat qiling.'
  });
});

app.get('/api/subscription/status', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const now = new Date();
    const userCreatedAt = req.user.created_at ? new Date(req.user.created_at) : now;
    const trialEndsAt = new Date(userCreatedAt.getTime() + 7 * 86400000);
    const isTrial = now.getTime() < trialEndsAt.getTime();

    const userExpiryValue = req.user.pro_expires_at || req.user.pro_until || req.user.pro_expires;
    const userExpiresAt = userExpiryValue ? new Date(userExpiryValue) : (isTrial ? trialEndsAt : null);
    const userIsActive = hasActiveReceiptPro(req.user, now);

    const isPro = userIsActive || isTrial;
    const hasExpired = !isPro && userExpiresAt && userExpiresAt.getTime() <= now.getTime();

    if (isTrial && !req.user.is_pro) {
      await supabase.from('users')
        .update({
          is_pro: true,
          pro_status: 'trial',
          pro_expires_at: trialEndsAt.toISOString(),
          pro_until: trialEndsAt.toISOString()
        })
        .eq('telegram_id', req.user.telegram_id)
        .catch(() => {});
    } else if (req.user.is_pro === true && !isPro) {
      await supabase.from('users')
        .update({ is_pro: false, pro_status: 'expired' })
        .eq('telegram_id', req.user.telegram_id)
        .catch(() => {});
    }

    const expiresAt = userExpiresAt;
    return res.json({
      isPro,
      status: isTrial ? 'trial' : (isPro ? 'active' : (hasExpired ? 'expired' : 'free')),
      isTrial,
      expired: hasExpired,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      daysLeft: expiresAt && isPro ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86400000)) : 0
    });
  } catch (error) {
    console.error('Obuna holati xatosi:', error.message);
    return sendError(res, 503, 'Obuna holatini yuklab bo‘lmadi.');
  }
});

app.post(['/api/payments/create', '/api/payments'], requireDatabase, requireTelegram, async (req, res) => {
  const planId = String(req.body.planId || '').trim();
  try {
    let plan = null;
    try {
      const { data: dbPlan, error: planError } = await supabase
        .from('subscription_plans')
        .select('id, name, duration_months, price_uzs')
        .eq('id', planId)
        .eq('active', true)
        .maybeSingle();
      if (!planError && dbPlan) plan = dbPlan;
    } catch (e) {}

    if (!plan) {
      const normalizedPlanId = planId.replace(/_/g, '-');
      plan = DEFAULT_PLANS.find(p => p.id === planId || p.id === normalizedPlanId);
    }
    if (!plan) return sendError(res, 404, 'Tarif topilmadi yoki faol emas.');

    try {
      const { count, error: pendingError } = await supabase
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('user_telegram_id', req.user.telegram_id)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString());
      if (!pendingError && count >= 5) {
        return sendError(res, 429, 'Kutilayotgan to‘lovlar limiti tugadi. Birozdan so‘ng urinib ko‘ring.');
      }
    } catch (e) {}

    let configuredDetails = {};
    try {
      const { data: settingsRow } = await supabase.from('app_settings')
        .select('value').eq('key', 'manual_payment_details').maybeSingle();
      if (settingsRow && settingsRow.value) {
        configuredDetails = JSON.parse(settingsRow.value) || {};
      }
    } catch (e) {}

    let payment = null;
    let insertError = null;
    try {
      const resNew = await supabase
        .from('payments')
        .insert({
          user_telegram_id: req.user.telegram_id,
          plan_id: plan.id,
          provider: 'manual',
          amount_uzs: plan.price_uzs,
          duration_months: plan.duration_months,
          status: 'pending',
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
        })
        .select('id, amount_uzs, duration_months, provider')
        .single();
      insertError = resNew.error;
      payment = resNew.data;
    } catch (e) {
      insertError = e;
    }

    if (insertError && (insertError.code === '42703' || String(insertError.message || '').includes('user_telegram_id'))) {
      const legacyInsert = await supabase
        .from('payments')
        .insert({
          telegram_id: req.user.telegram_id,
          plan: plan.id,
          amount: plan.price_uzs,
          status: 'pending'
        })
        .select('id, amount, plan')
        .single();
      if (!legacyInsert.error && legacyInsert.data) {
        insertError = null;
        payment = {
          id: legacyInsert.data.id,
          amount_uzs: legacyInsert.data.amount,
          duration_months: plan.duration_months,
          provider: 'manual'
        };
      } else {
        insertError = legacyInsert.error;
      }
    }

    if (insertError) throw insertError;

    return res.status(201).json({
      ok: true,
      payment_id: 'pay_' + Date.now(),
      card_number: String(configuredDetails.account || process.env.PAYMENT_CARD || '9860 **** **** 0000').slice(0, 100),
      card_holder: String(configuredDetails.accountName || process.env.PAYMENT_CARD_HOLDER || 'XARAJAT AI').slice(0, 100),
      bank: String(configuredDetails.bank || '').slice(0, 100),
      instructions: String(configuredDetails.instructions || '').slice(0, 1000),
      amount: payment.amount_uzs,
      message: 'To‘lovni amalga oshirib, chekni botga yuboring',
      paymentId: payment.id,
      provider: payment.provider,
      amountUzs: payment.amount_uzs,
      durationMonths: payment.duration_months
    });
  } catch (error) {
    console.error('To‘lov yaratish xatosi:', error.message);
    return sendError(res, 503, 'To‘lovni tayyorlab bo‘lmadi.');
  }
});

app.get('/api/payments/history', requireDatabase, requireTelegram, async (req, res) => {
  let { data, error } = await supabase
    .from('payments')
    .select('id, plan_id, provider, amount_uzs, duration_months, status, created_at, paid_at')
    .eq('user_telegram_id', req.user.telegram_id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error && (error.code === '42703' || String(error.message || '').includes('user_telegram_id'))) {
    const legacy = await supabase
      .from('payments')
      .select('id, plan, amount, status, created_at')
      .eq('telegram_id', req.user.telegram_id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (!legacy.error && legacy.data) {
      data = legacy.data.map(item => {
        const pId = item.plan || 'unknown';
        const dMatch = String(pId).match(/^(\d+)[_-]/);
        const m = dMatch ? Number(dMatch[1]) : 1;
        return {
          id: item.id,
          plan_id: pId,
          provider: 'manual',
          amount_uzs: item.amount || 0,
          duration_months: m,
          status: item.status,
          created_at: item.created_at
        };
      });
      error = null;
    }
  }

  if (error) return sendError(res, 503, 'To‘lov tarixini yuklab bo‘lmadi.');
  return res.json(data || []);
});

app.post('/api/payments/:id/receipt', requireDatabase, requireTelegram, receiptUpload.single('receipt'), async (req, res) => {
  const paymentId = String(req.params.id || '');
  const reference = String(req.body.reference || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
    return sendError(res, 400, 'To‘lov identifikatori noto‘g‘ri.');
  }
  if (!reference || reference.length > 100) return sendError(res, 400, 'To‘lov izohi yoki tranzaksiya raqamini kiriting.');
  if (!req.file) return sendError(res, 400, 'To‘lov chekini rasm sifatida biriktiring.');
  if (!receiptMimeMatches(req.file.buffer, req.file.mimetype)) {
    return sendError(res, 400, 'Yuklangan fayl haqiqiy JPG, PNG yoki WebP rasm emas.');
  }

  const { data: payment, error: paymentError } = await supabase.from('payments')
    .select('id, status, provider_data, expires_at')
    .eq('id', paymentId)
    .eq('user_telegram_id', req.user.telegram_id)
    .eq('provider', 'manual')
    .maybeSingle();
  if (paymentError) return sendError(res, 503, 'To‘lovni tekshirib bo‘lmadi.');
  if (!payment) return sendError(res, 404, 'To‘lov topilmadi.');
  if (payment.status !== 'pending') return sendError(res, 409, 'Bu to‘lov cheki allaqachon yuborilgan yoki yopilgan.');
  if (new Date(payment.expires_at) <= new Date()) return sendError(res, 410, 'To‘lov muddati tugagan. Yangi so‘rov yarating.');

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype];
  const receiptPath = req.user.telegram_id + '/' + payment.id + '/' + crypto.randomUUID() + '.' + extension;
  const { error: uploadError } = await supabase.storage.from('manual-payment-receipts')
    .upload(receiptPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (uploadError) {
    console.error('Chekni saqlash xatosi:', uploadError.message);
    return sendError(res, 503, 'Chekni saqlab bo‘lmadi. Storage bucket sozlamalarini tekshiring.');
  }

  const providerData = Object.assign({}, payment.provider_data || {}, {
    receipt_path: receiptPath,
    receipt_reference: reference
  });
  const { data: updated, error: updateError } = await supabase.from('payments')
    .update({ status: 'review', provider_data: providerData })
    .eq('id', payment.id).eq('status', 'pending')
    .select('id, status').maybeSingle();
  if (updateError || !updated) {
    await supabase.storage.from('manual-payment-receipts').remove([receiptPath]);
    if (updateError) console.error('Chek yuborilgan holatni saqlash xatosi:', updateError.message);
    return sendError(res, updateError ? 503 : 409, 'Chek holatini saqlab bo‘lmadi. Qayta urinib ko‘ring.');
  }
  return res.json({ ok: true, status: updated.status });
});

app.post('/api/receipts/scan', requireDatabase, requireTelegram, requireReceiptPro, receiptUpload.single('image'), async (req, res) => {
  if (!req.file) return sendError(res, 400, 'Chek rasmini biriktiring.');
  if (!receiptMimeMatches(req.file.buffer, req.file.mimetype)) {
    return sendError(res, 400, 'Yuklangan fayl haqiqiy JPG, PNG yoki WebP rasm emas.');
  }
  if (!process.env.AI_API_KEY) return sendError(res, 503, 'Chekni AI orqali o‘qish serverda sozlanmagan.');
  if (!checkAiRateLimit(req.user.telegram_id)) {
    return sendError(res, 429, 'Chek skanerlash tezligi bo‘yicha limitga yetdingiz. Biroz kuting.');
  }
  const { data: aiEnabledSetting, error: aiSettingError } = await supabase.from('app_settings')
    .select('value').eq('key', 'ai_enabled').maybeSingle();
  if (aiSettingError) return sendError(res, 503, 'AI sozlamalarini tekshirib bo‘lmadi.');
  if (aiEnabledSetting && aiEnabledSetting.value === 'false') {
    return sendError(res, 503, 'AI xizmati administrator tomonidan vaqtincha o‘chirilgan.');
  }

  try {
    const content = await enqueueAiRequest(Boolean(req.user.is_pro), async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        return await requestGeminiWithImage(req.file.buffer, req.file.mimetype, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
    });
    return res.json(parseReceiptVisionData(content));
  } catch (error) {
    console.error('Chekni Vision orqali o‘qish xatosi:', error.message);
    return sendError(res, error.name === 'AbortError' ? 504 : 502, 'Chek AI orqali o‘qilmadi.');
  }
});

app.post('/api/ai/consume', requireDatabase, requireTelegram, async (req, res) => {
  if (!checkAiRateLimit(req.user.telegram_id)) {
    return sendError(res, 429, 'AI so‘rovlari tezligi bo‘yicha limitga yetdingiz. Biroz kuting.');
  }
  const { data, error } = await supabase.rpc('consume_ai_request', {
    p_telegram_id: req.user.telegram_id
  });
  if (error) return sendError(res, 503, 'AI limiti tekshirilmadi.');
  if (!data.allowed || !aiUsageAllowed(data.isPro, Number(data.used) - 1)) {
    return res.status(429).json({
      error: 'Bepul tarifdagi kunlik AI limiti tugadi.',
      ...data
    });
  }
  return res.json(data);
});

app.post('/api/ai/chat', requireDatabase, requireTelegram, async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question || question.length > 4000) {
    return sendError(res, 400, 'Savol 1–4000 belgi oralig‘ida bo‘lishi kerak.');
  }
  if (!process.env.AI_API_KEY) return sendError(res, 503, 'AI xizmati serverda sozlanmagan.');
  const { data: aiEnabledSetting, error: aiSettingError } = await supabase.from('app_settings')
    .select('value').eq('key', 'ai_enabled').maybeSingle();
  if (aiSettingError) return sendError(res, 503, 'AI sozlamalarini tekshirib bo‘lmadi.');
  if (aiEnabledSetting && aiEnabledSetting.value === 'false') {
    return sendError(res, 503, 'AI xizmati administrator tomonidan vaqtincha o‘chirilgan.');
  }
  if (!checkAiRateLimit(req.user.telegram_id)) {
    return sendError(res, 429, 'AI so‘rovlari tezligi bo‘yicha limitga yetdingiz. Biroz kuting.');
  }

  const { data: usage, error: usageError } = await supabase.rpc('consume_ai_request', {
    p_telegram_id: req.user.telegram_id
  });
  if (usageError) return sendError(res, 503, 'AI limiti tekshirilmadi.');
  if (!usage.allowed || !aiUsageAllowed(usage.isPro, Number(usage.used) - 1)) {
    return res.status(429).json({ error: 'Bepul tarifdagi kunlik AI limiti tugadi.', ...usage });
  }

  try {
    const answer = await enqueueAiRequest(Boolean(usage.isPro), async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        return await requestGemini(question, await getAiSystemPrompt(), controller.signal);
      } finally {
        clearTimeout(timeout);
      }
    });
    return res.json({
      answer,
      isPro: usage.isPro,
      used: usage.used,
      limit: usage.limit
    });
  } catch (error) {
    console.error(error);
    return sendError(res, error.status || (error.name === 'AbortError' ? 504 : 502), 'AI xizmatiga ulanib bo‘lmadi.');
  }
});

// Click merchant callbacks: prepare (action=0) and complete (action=1).
app.post('/api/payments/click', requireDatabase, async (req, res) => {
  const payload = req.body || {};
  const secret = process.env.CLICK_SECRET_KEY;
  const action = Number(payload.action);
  const isComplete = action === 1;
  if (!secret || !process.env.CLICK_SERVICE_ID) {
    return clickResponse(res, payload, -1, 'Click server configuration is missing');
  }
  if (String(payload.service_id) !== String(process.env.CLICK_SERVICE_ID) ||
      !verifyClickSignature(payload, secret, isComplete)) {
    return clickResponse(res, payload, -1, 'Signature or service mismatch');
  }
  if (![0, 1].includes(action)) return clickResponse(res, payload, -3, 'Action not found');

  try {
    const payment = await findPayment(String(payload.merchant_trans_id || ''));
    if (!payment || payment.provider !== 'click') return clickResponse(res, payload, -5, 'Payment not found');
    if (Number(payload.amount) !== Number(payment.amount_uzs)) {
      return clickResponse(res, payload, -2, 'Incorrect amount');
    }
    if (action === 1 && payment.status === 'paid') {
      return clickResponse(res, payload, 0, 'Already processed');
    }
    if (new Date(payment.expires_at) <= new Date()) {
      await supabase.from('payments').update({ status: 'canceled' })
        .eq('id', payment.id).eq('status', 'pending');
      return clickResponse(res, payload, -6, 'Payment has expired');
    }

    if (action === 0) {
      if (payment.status !== 'pending') {
        return clickResponse(res, payload, payment.status === 'paid' ? -4 : -6, 'Payment is not pending');
      }
      const { error } = await supabase.from('payments')
        .update({
          external_transaction_id: String(payload.click_trans_id),
          provider_data: { click_prepare_id: String(payment.click_prepare_id) }
        })
        .eq('id', payment.id)
        .eq('status', 'pending');
      if (error) throw error;
      return clickResponse(res, payload, 0, 'Success', { merchant_prepare_id: payment.click_prepare_id });
    }

    if (Number(payload.error) !== 0) {
      await supabase.from('payments').update({ status: 'failed' })
        .eq('id', payment.id).eq('status', 'pending');
      return clickResponse(res, payload, Number(payload.error) || -9, 'Payment was not completed');
    }
    const expectedPrepareId = payment.provider_data && payment.provider_data.click_prepare_id;
    if (!expectedPrepareId || String(payload.click_prepare_id) !== String(expectedPrepareId)) {
      return clickResponse(res, payload, -8, 'Prepare transaction mismatch');
    }

    await activatePayment(payment, payload.click_trans_id);
    return clickResponse(res, payload, 0, 'Success');
  } catch (error) {
    console.error('Click callback xatosi:', error.message);
    return clickResponse(res, payload, -9, 'Internal payment processing error');
  }
});

// Payme Merchant API JSON-RPC endpoint. Only verified callbacks can change payment state.
app.post('/api/payments/payme', requireDatabase, async (req, res) => {
  const body = req.body || {};
  const id = body.id;
  if (!checkPaymeAuth(req)) {
    return res.status(401).json(paymeError(id, -32504, 'Insufficient privilege'));
  }

  try {
    const params = body.params || {};
    const method = body.method;
    const paymentId = params.account && String(params.account.payment_id || '');
    const paymeId = String(params.id || '');

    if (method === 'CheckPerformTransaction') {
      const payment = await findPayment(paymentId);
      if (!payment || payment.provider !== 'payme') return res.json(paymeError(id, -31050, 'Payment not found'));
      if (Number(params.amount) !== Number(payment.amount_uzs) * 100) {
        return res.json(paymeError(id, -31001, 'Incorrect amount'));
      }
      if (new Date(payment.expires_at) <= new Date()) return res.json(paymeError(id, -31008, 'Payment has expired'));
      if (payment.status !== 'pending') return res.json(paymeError(id, -31099, 'Payment is not available'));
      return res.json(paymeResult(id, { allow: true }));
    }

    if (method === 'CreateTransaction') {
      const payment = await findPayment(paymentId);
      if (!payment || payment.provider !== 'payme') return res.json(paymeError(id, -31050, 'Payment not found'));
      if (Number(params.amount) !== Number(payment.amount_uzs) * 100) {
        return res.json(paymeError(id, -31001, 'Incorrect amount'));
      }
      if (payment.provider_transaction_id === paymeId) {
        const state = payment.status === 'paid' ? 2 : payment.status === 'canceled' ? -1 : 1;
        return res.json(paymeResult(id, paymeTransaction(
          payment,
          paymeId,
          state,
          Number(payment.provider_data && payment.provider_data.payme_create_time) || Number(params.time) || Date.now(),
          payment.paid_at ? Date.parse(payment.paid_at) : 0,
          Number(payment.provider_data && payment.provider_data.payme_cancel_time) || 0,
          payment.provider_data && payment.provider_data.cancel_reason
        )));
      }
      if (new Date(payment.expires_at) <= new Date()) {
        await supabase.from('payments').update({ status: 'canceled' }).eq('id', payment.id).eq('status', 'pending');
        return res.json(paymeError(id, -31008, 'Payment has expired'));
      }
      if (payment.status === 'paid') return res.json(paymeError(id, -31099, 'Payment already completed'));
      if (payment.status !== 'pending') return res.json(paymeError(id, -31008, 'Payment is canceled'));
      if (payment.provider_transaction_id && payment.provider_transaction_id !== paymeId) {
        return res.json(paymeError(id, -31099, 'Payment already has another transaction'));
      }
      const { data: duplicate, error: duplicateError } = await supabase.from('payments')
        .select('id').eq('provider', 'payme').eq('provider_transaction_id', paymeId).maybeSingle();
      if (duplicateError) throw duplicateError;
      if (duplicate && duplicate.id !== payment.id) {
        return res.json(paymeError(id, -31099, 'Transaction ID has already been used'));
      }

      const createdAt = Number(payment.provider_data && payment.provider_data.payme_create_time) || Date.now();
      const paymeCreatedAt = Number(payment.provider_data && payment.provider_data.payme_time) ||
        Number(params.time) || Date.now();
      const { error } = await supabase.from('payments').update({
        provider_transaction_id: paymeId,
        external_transaction_id: paymeId,
        provider_data: { payme_create_time: createdAt, payme_time: paymeCreatedAt }
      }).eq('id', payment.id).eq('status', 'pending');
      if (error) throw error;
      return res.json(paymeResult(id, paymeTransaction(payment, paymeId, 1, createdAt)));
    }

    if (method === 'PerformTransaction') {
      const { data: payment, error } = await supabase.from('payments')
        .select('id, user_telegram_id, plan_id, provider, amount_uzs, status, provider_transaction_id, external_transaction_id, provider_data, created_at, expires_at, paid_at')
        .eq('provider_transaction_id', paymeId).eq('provider', 'payme').maybeSingle();
      if (error) throw error;
      if (!payment) return res.json(paymeError(id, -31003, 'Transaction not found'));
      if (payment.status === 'paid') {
        return res.json(paymeResult(id, paymeTransaction(
          payment,
          paymeId,
          2,
          Number(payment.provider_data && payment.provider_data.payme_create_time),
          Date.parse(payment.paid_at)
        )));
      }
      if (payment.status !== 'pending') return res.json(paymeError(id, -31008, 'Transaction is canceled'));
      if (new Date(payment.expires_at) <= new Date()) {
        const { error: cancelError } = await supabase.rpc('cancel_pending_payment', {
          p_provider_transaction_id: paymeId,
          p_reason: 4
        });
        if (cancelError) throw cancelError;
        return res.json(paymeError(id, -31008, 'Payment has expired'));
      }
      const result = await activatePayment(payment, paymeId);
      const performedAt = Date.now();
      return res.json(paymeResult(id, paymeTransaction(
        payment,
        paymeId,
        2,
        Number(payment.provider_data && payment.provider_data.payme_create_time),
        performedAt
      )));
    }

    if (method === 'CancelTransaction') {
      const { data: payment, error } = await supabase.from('payments')
        .select('id, user_telegram_id, plan_id, provider, amount_uzs, status, provider_transaction_id, external_transaction_id, provider_data, created_at, expires_at, paid_at')
        .eq('provider_transaction_id', paymeId).eq('provider', 'payme').maybeSingle();
      if (error) throw error;
      if (!payment) return res.json(paymeError(id, -31003, 'Transaction not found'));
      const canceledAt = Date.now();
      const { data: cancellation, error: cancelError } = await supabase.rpc('cancel_pending_payment', {
        p_provider_transaction_id: paymeId,
        p_reason: Number.isInteger(params.reason) ? params.reason : null
      });
      if (cancelError) throw cancelError;
      if (!cancellation.canceled && cancellation.paid) {
        return res.json(paymeError(id, -31007, 'Transaction already performed'));
      }
      return res.json(paymeResult(id, paymeTransaction(
        payment,
        paymeId,
        -1,
        Number(payment.provider_data && payment.provider_data.payme_create_time) || Date.parse(payment.created_at),
        0,
        cancellation.cancelTime || Number(payment.provider_data && payment.provider_data.payme_cancel_time) || canceledAt,
        params.reason || null
      )));
    }

    if (method === 'CheckTransaction') {
      const { data: payment, error } = await supabase.from('payments')
        .select('id, user_telegram_id, plan_id, provider, amount_uzs, status, provider_transaction_id, external_transaction_id, provider_data, created_at, expires_at, paid_at')
        .eq('provider_transaction_id', paymeId).eq('provider', 'payme').maybeSingle();
      if (error) throw error;
      if (!payment) return res.json(paymeError(id, -31003, 'Transaction not found'));
      const expired = payment.status === 'pending' && new Date(payment.expires_at) <= new Date();
      let expirationTime = 0;
      if (expired) {
        const { data: cancellation, error: cancelError } = await supabase.rpc('cancel_pending_payment', {
          p_provider_transaction_id: paymeId,
          p_reason: 4
        });
        if (cancelError) throw cancelError;
        expirationTime = Number(cancellation.cancelTime) || 0;
      }
      const state = payment.status === 'paid' ? 2 : payment.status === 'pending' && !expired ? 1 : -1;
      return res.json(paymeResult(id, paymeTransaction(
        payment,
        paymeId,
        state,
        Number(payment.provider_data && payment.provider_data.payme_create_time) || Date.parse(payment.created_at),
        payment.paid_at ? Date.parse(payment.paid_at) : 0,
        expirationTime || Number(payment.provider_data && payment.provider_data.payme_cancel_time) || 0,
        payment.provider_data && payment.provider_data.cancel_reason
      )));
    }

    if (method === 'GetStatement') {
      const from = Number(params.from), to = Number(params.to);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
        return res.json(paymeError(id, -32602, 'Invalid statement period'));
      }
      const { data: payments, error } = await supabase.from('payments')
        .select('id, user_telegram_id, plan_id, provider, amount_uzs, status, provider_transaction_id, external_transaction_id, provider_data, created_at, paid_at')
        .eq('provider', 'payme')
        .not('provider_transaction_id', 'is', null)
        .gte('created_at', new Date(from - 43200000).toISOString())
        .lte('created_at', new Date(to + 43200000).toISOString())
        .order('created_at')
        .limit(5000);
      if (error) throw error;
      const transactions = payments.filter(payment => {
        const paymeTime = Number(payment.provider_data && payment.provider_data.payme_time) ||
          Number(payment.provider_data && payment.provider_data.payme_create_time) ||
          Date.parse(payment.created_at);
        return paymeTime >= from && paymeTime <= to;
      }).map(payment => {
        const createdAt = Number(payment.provider_data && payment.provider_data.payme_create_time) || Date.parse(payment.created_at);
        const paymeTime = Number(payment.provider_data && payment.provider_data.payme_time) || createdAt;
        return Object.assign({
          id: payment.provider_transaction_id,
          time: paymeTime,
          amount: Number(payment.amount_uzs) * 100,
          account: { payment_id: payment.id }
        }, paymeTransaction(
          payment,
          payment.provider_transaction_id,
          payment.status === 'paid' ? 2 : payment.status === 'pending' ? 1 : -1,
          createdAt,
          payment.paid_at ? Date.parse(payment.paid_at) : 0,
          Number(payment.provider_data && payment.provider_data.payme_cancel_time) || 0,
          payment.provider_data && payment.provider_data.cancel_reason
        ));
      });
      return res.json(paymeResult(id, { transactions }));
    }

    return res.json(paymeError(id, -32601, 'Method not found'));
  } catch (error) {
    console.error('Payme callback xatosi:', error.message);
    return res.status(500).json(paymeError(id, -32400, 'Payment processing error'));
  }
});

app.get('/api/admin/pro-users', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  try {
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('telegram_id, first_name, username, is_pro, pro_status, pro_until, pro_expires_at')
      .eq('is_pro', true);
    if (usersError) throw usersError;

    const list = (users || []).map(u => ({
      user_telegram_id: u.telegram_id,
      expires_at: u.pro_expires_at || u.pro_until || null,
      status: 'active',
      user: {
        first_name: u.first_name,
        username: u.username
      }
    }));
    return res.json(list);
  } catch (error) {
    console.error('PRO foydalanuvchilarini olish xatosi:', error.message);
    return sendError(res, 503, 'PRO foydalanuvchilarini yuklab bo‘lmadi.');
  }
});

app.get('/api/admin/payments', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('payments')
      .select('*')
      .order('created_at', { ascending: false }).limit(500);
    if (error) {
      console.error('To‘lovlar tarixini yuklab olish xatosi:', error.message);
      return sendError(res, 503, 'To‘lovlar tarixini yuklab bo‘lmadi.');
    }
    const payments = await Promise.all((data || []).map(async payment => {
      const receiptPath = payment.provider_data && payment.provider_data.receipt_path;
      let receiptUrl = payment.receipt_url || null;
      if (receiptPath) {
        try {
          const { data: signed, error: signedError } = await supabase.storage
            .from('manual-payment-receipts').createSignedUrl(receiptPath, 600);
          if (!signedError && signed) {
            receiptUrl = signed.signedUrl;
          }
        } catch (_) {}
      }
      return {
        id: payment.id,
        user_telegram_id: payment.user_telegram_id || payment.telegram_id,
        plan_id: payment.plan_id || payment.plan,
        provider: payment.provider || 'manual',
        amount_uzs: payment.amount_uzs || payment.amount,
        duration_months: payment.duration_months || 1,
        status: payment.status,
        provider_transaction_id: payment.provider_transaction_id || null,
        receipt_reference: payment.provider_data && payment.provider_data.receipt_reference || null,
        receiptUrl,
        created_at: payment.created_at,
        paid_at: payment.paid_at
      };
    }));
    return res.json(payments);
  } catch (error) {
    console.error('To‘lovlar admin xatosi:', error.message);
    return sendError(res, 503, 'To‘lovlar tarixini yuklab bo‘lmadi.');
  }
});

app.post('/api/admin/payments/:id/approve', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const paymentId = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
    return sendError(res, 400, 'To‘lov identifikatori noto‘g‘ri.');
  }

  let rpcSuccess = false;
  let expiresAt = null;
  let alreadyProcessed = false;

  try {
    const { data, error } = await supabase.rpc('approve_manual_payment', {
      p_payment_id: paymentId,
      p_admin_telegram_id: req.user.telegram_id
    });
    if (!error && data && data.ok) {
      rpcSuccess = true;
      expiresAt = data.expiresAt;
      alreadyProcessed = Boolean(data.alreadyProcessed);
    } else if (error) {
      console.warn('RPC approve_manual_payment xatosi:', error.message, '- to‘g‘ridan-to‘g‘ri zaxira tasdiqlashga o‘tilmoqda.');
    }
  } catch (rpcErr) {
    console.warn('RPC chaqirish xatosi:', rpcErr.message);
  }

  if (!rpcSuccess) {
    const { data: payment, error: pError } = await supabase.from('payments')
      .select('*')
      .eq('id', paymentId)
      .maybeSingle();

    if (pError || !payment) {
      console.error('To‘lov topilmadi:', pError ? pError.message : 'Topilmadi');
      return sendError(res, 404, 'To‘lov topilmadi.');
    }

    if (payment.status === 'paid') {
      return res.json({ ok: true, alreadyProcessed: true });
    }

    const targetUserId = payment.user_telegram_id || payment.telegram_id;
    if (!targetUserId) {
      return sendError(res, 400, 'To‘lov egasi ma’lumoti topilmadi.');
    }

    let months = Number(payment.duration_months);
    if (!months || Number.isNaN(months) || months < 1) {
      const pId = String(payment.plan_id || payment.plan || '');
      if (pId.includes('12') || pId.includes('365')) months = 12;
      else if (pId.includes('6') || pId.includes('180')) months = 6;
      else if (pId.includes('3') || pId.includes('90')) months = 3;
      else months = 1;
    }
    const durationDays = months === 12 ? 365 : months * 30;

    const now = new Date();
    let currentExpiry = null;
    try {
      const { data: user } = await supabase.from('users')
        .select('is_pro, pro_status, pro_until, pro_expires_at')
        .eq('telegram_id', targetUserId)
        .maybeSingle();
      if (user) {
        const expVal = user.pro_expires_at || user.pro_until;
        if (expVal) {
          const d = new Date(expVal);
          if (!Number.isNaN(d.getTime()) && d > now) {
            currentExpiry = d;
          }
        }
      }
    } catch (e) {
      console.warn('Foydalanuvchi joriy obunasini tekshirish xatosi:', e.message);
    }

    const baseDate = currentExpiry || now;
    expiresAt = new Date(baseDate.getTime() + durationDays * 86400000).toISOString();

    const updateVariants = [
      { is_pro: true, pro_status: 'pro', pro_until: expiresAt, pro_expires_at: expiresAt },
      { is_pro: true, pro_status: 'pro', pro_until: expiresAt },
      { is_pro: true, pro_until: expiresAt },
      { is_pro: true }
    ];
    for (const variant of updateVariants) {
      const { error: uErr } = await supabase.from('users')
        .upsert(Object.assign({ telegram_id: targetUserId }, variant), { onConflict: 'telegram_id' });
      if (!uErr) break;
      const { error: updErr } = await supabase.from('users')
        .update(variant)
        .eq('telegram_id', targetUserId);
      if (!updErr) break;
    }

    await supabase.from('payments').update({
      status: 'paid',
      paid_at: now.toISOString(),
      provider_data: Object.assign({}, payment.provider_data || {}, {
        reviewed_by: req.user.telegram_id,
        reviewed_at: now.toISOString(),
        approval_source: 'api'
      })
    }).eq('id', paymentId);

    try {
      await supabase.from('subscriptions').upsert({
        user_telegram_id: targetUserId,
        status: 'active',
        starts_at: now.toISOString(),
        expires_at: expiresAt,
        ends_at: expiresAt,
        source: 'manual_payment',
        updated_at: now.toISOString()
      }, { onConflict: 'user_telegram_id' });
    } catch (e) {}
  }

  const { data: paymentInfo } = await supabase.from('payments')
    .select('user_telegram_id, telegram_id')
    .eq('id', paymentId)
    .maybeSingle();
  const notifyId = paymentInfo && (paymentInfo.user_telegram_id || paymentInfo.telegram_id);
  if (notifyId) {
    await notifyTelegramUser(
      notifyId,
      '🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: ' +
        formatSubscriptionDate(expiresAt) + ' gacha'
    ).catch(() => {});
  }
  return res.json({ ok: true, expiresAt, alreadyProcessed });
});

app.post('/api/admin/payments/:id/reject', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const paymentId = String(req.params.id || '');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
    return sendError(res, 400, 'To‘lov identifikatori noto‘g‘ri.');
  }
  const { data: payment, error: findError } = await supabase.from('payments')
    .select('id, user_telegram_id, status, provider, provider_data')
    .eq('id', paymentId).maybeSingle();
  if (findError) return sendError(res, 503, 'To‘lov holatini tekshirib bo‘lmadi.');
  if (!payment || payment.provider !== 'manual' || !['pending', 'review'].includes(payment.status)) {
    return sendError(res, 409, 'Faqat ochiq qo‘lda to‘lovni rad etish mumkin.');
  }
  const { data: updated, error } = await supabase.from('payments')
    .update({
      status: 'rejected',
      provider_data: Object.assign({}, payment.provider_data || {}, {
        rejected_by: req.user.telegram_id,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason
      })
    })
    .eq('id', paymentId).in('status', ['pending', 'review'])
    .select('id').maybeSingle();
  if (error) return sendError(res, 503, 'To‘lovni rad etib bo‘lmadi.');
  if (!updated) return sendError(res, 409, 'To‘lov holati boshqa administrator tomonidan o‘zgartirilgan.');
  await notifyTelegramUser(
    payment.user_telegram_id,
    '⚠️ To‘lovingiz tasdiqlanmadi.' + (reason ? ' Sabab: ' + reason : ' Iltimos, yordam uchun administratorga murojaat qiling.')
  );
  return res.json({ ok: true });
});

app.get('/api/admin/payment-details', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('value').eq('key', 'manual_payment_details').maybeSingle();
  if (error) return sendError(res, 503, 'To‘lov rekvizitlarini yuklab bo‘lmadi.');
  if (!data) return res.json({});
  try {
    return res.json(JSON.parse(data.value));
  } catch (parseError) {
    console.error('Admin to‘lov rekvizitlari JSON xatosi:', parseError.message);
    return sendError(res, 503, 'To‘lov rekvizitlari noto‘g‘ri saqlangan.');
  }
});

app.put('/api/admin/payment-details', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const details = {
    account: String(req.body.account || '').trim().slice(0, 100),
    accountName: String(req.body.accountName || '').trim().slice(0, 100),
    bank: String(req.body.bank || '').trim().slice(0, 100),
    instructions: String(req.body.instructions || '').trim().slice(0, 1000)
  };
  if (!details.account || !details.accountName || !details.bank) {
    return sendError(res, 400, 'Karta/hamyon, egasi va bank nomini kiriting.');
  }
  const { error } = await supabase.from('app_settings').upsert({
    key: 'manual_payment_details',
    value: JSON.stringify(details),
    updated_at: new Date().toISOString()
  });
  if (error) return sendError(res, 503, 'To‘lov rekvizitlarini saqlab bo‘lmadi.');
  return res.json({ ok: true });
});

const DEFAULT_AI_SYSTEM_PROMPT =
  'Siz Xarajat AI moliyaviy yordamchisisiz. O‘zbek tilida aniq, qisqa va ehtiyotkor javob bering. Bu umumiy ma’lumot, professional moliyaviy maslahat emas.';

async function getAiSystemPrompt() {
  const { data, error } = await supabase.from('app_settings')
    .select('value').eq('key', 'ai_system_prompt').maybeSingle();
  if (error) throw error;
  return data && data.value ? String(data.value).slice(0, 2000) : DEFAULT_AI_SYSTEM_PROMPT;
}

app.get('/api/admin/ai-settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('key, value').in('key', ['ai_system_prompt', 'ai_enabled']);
  if (error) return sendError(res, 503, 'AI sozlamalarini yuklab bo‘lmadi.');
  const settings = Object.fromEntries(data.map(item => [item.key, item.value]));
  return res.json({
    enabled: settings.ai_enabled !== 'false',
    systemPrompt: settings.ai_system_prompt || DEFAULT_AI_SYSTEM_PROMPT,
    providerConfigured: Boolean(process.env.AI_API_KEY)
  });
});

app.put('/api/admin/ai-settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const systemPrompt = String(req.body.systemPrompt || '').trim();
  if (!systemPrompt || systemPrompt.length > 2000 || typeof req.body.enabled !== 'boolean') {
    return sendError(res, 400, 'AI ko‘rsatmasi 1–2 000 belgi va holat true/false bo‘lishi kerak.');
  }
  const values = [
    { key: 'ai_system_prompt', value: systemPrompt },
    { key: 'ai_enabled', value: String(req.body.enabled) }
  ];
  const { error } = await supabase.from('app_settings').upsert(values);
  if (error) return sendError(res, 503, 'AI sozlamalarini saqlab bo‘lmadi.');
  return res.json({ ok: true });
});

app.get('/api/admin/categories', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('app_settings')
    .select('value').eq('key', 'transaction_categories').maybeSingle();
  if (error) return sendError(res, 503, 'Kategoriyalar sozlamasini yuklab bo‘lmadi.');
  if (!data) return res.json(DEFAULT_CATEGORIES);
  try {
    return res.json(JSON.parse(data.value));
  } catch (parseError) {
    console.error('Admin kategoriyalari JSON xatosi:', parseError.message);
    return sendError(res, 503, 'Kategoriyalar sozlamasi noto‘g‘ri saqlangan.');
  }
});

app.put('/api/admin/categories', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const normalized = {};
  for (const type of ['income', 'expense']) {
    const items = req.body[type];
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      return sendError(res, 400, 'Har bir tur uchun 1–30 ta kategoriya kiriting.');
    }
    const names = new Set();
    normalized[type] = [];
    for (const item of items) {
      const name = String(item && item.v || '').trim().slice(0, 40);
      const icon = String(item && item.e || '').trim().slice(0, 8);
      if (!name || !icon || names.has(name.toLocaleLowerCase())) {
        return sendError(res, 400, 'Kategoriya nomlari takrorlanmasin va belgi bilan birga kiriting.');
      }
      names.add(name.toLocaleLowerCase());
      normalized[type].push({ v: name, e: icon });
    }
  }
  const { error } = await supabase.from('app_settings').upsert({
    key: 'transaction_categories',
    value: JSON.stringify(normalized),
    updated_at: new Date().toISOString()
  });
  if (error) return sendError(res, 503, 'Kategoriyalarni saqlab bo‘lmadi.');
  return res.json({ ok: true, categories: normalized });
});

app.get('/api/admin/system-settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const keys = ['notifications_enabled', 'support_url', 'support_message'];
  const { data, error } = await supabase.from('app_settings').select('key, value').in('key', keys);
  if (error) return sendError(res, 503, 'Tizim sozlamalarini yuklab bo‘lmadi.');
  const settings = Object.fromEntries(data.map(item => [item.key, item.value]));
  const supportUrl = validateHttpsUrl(settings.support_url || '');
  if (supportUrl === null) return sendError(res, 503, 'Saqlangan yordam havolasi noto‘g‘ri.');
  return res.json({
    notificationsEnabled: settings.notifications_enabled !== 'false',
    supportUrl,
    supportMessage: settings.support_message || 'Yordam uchun bot administratoriga murojaat qiling.'
  });
});

app.put('/api/admin/system-settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  if (typeof req.body.notificationsEnabled !== 'boolean') {
    return sendError(res, 400, 'Bildirishnomalar holatini tanlang.');
  }
  const supportUrl = String(req.body.supportUrl || '').trim().slice(0, 300);
  const supportMessage = String(req.body.supportMessage || '').trim().slice(0, 2000);
  if (supportUrl) {
    try {
      if (new URL(supportUrl).protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      return sendError(res, 400, 'Yordam havolasi HTTPS formatida bo‘lishi kerak.');
    }
  }
  const values = [
    { key: 'notifications_enabled', value: String(req.body.notificationsEnabled) },
    { key: 'support_url', value: supportUrl },
    { key: 'support_message', value: supportMessage }
  ];
  const { error } = await supabase.from('app_settings').upsert(values);
  if (error) return sendError(res, 503, 'Tizim sozlamalarini saqlab bo‘lmadi.');
  return res.json({ ok: true });
});

app.get('/api/admin/revenue', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('subscription_revenue');
    if (!error && data) return res.json(data);
  } catch (_) {}
  try {
    const { data: paidPayments } = await supabase.from('payments').select('amount_uzs').eq('status', 'paid');
    const totalUzs = (paidPayments || []).reduce((acc, p) => acc + (Number(p.amount_uzs) || 0), 0);
    return res.json({ totalUzs });
  } catch (error) {
    return sendError(res, 503, 'Obuna daromadini hisoblab bo‘lmadi.');
  }
});

async function grantUserPro(telegramId, months, source = 'admin_manual', note = null) {
  const now = new Date();
  let currentExpiry = null;
  const { data: user } = await supabase
    .from('users')
    .select('id, telegram_id, is_pro, pro_expires_at, pro_until')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (user && user.is_pro) {
    const stored = user.pro_expires_at || user.pro_until;
    if (stored) {
      const expDate = new Date(stored);
      if (!Number.isNaN(expDate.getTime()) && expDate > now) {
        currentExpiry = expDate;
      }
    }
  }

  const baseDate = currentExpiry || now;
  const expiresAt = new Date(baseDate.getTime() + months * 30 * 86400000).toISOString();

  const updatePayload = {
    telegram_id: telegramId,
    is_pro: true,
    pro_status: 'pro',
    pro_expires_at: expiresAt,
    pro_until: expiresAt,
    last_active_at: now.toISOString()
  };

  const { error: upsertErr } = await supabase
    .from('users')
    .upsert(updatePayload, { onConflict: 'telegram_id' });

  if (upsertErr) {
    await supabase.from('users').update({
      is_pro: true,
      pro_status: 'pro',
      pro_expires_at: expiresAt,
      pro_until: expiresAt
    }).eq('telegram_id', telegramId);
  }

  try {
    await supabase.from('subscriptions').insert({
      telegram_id: telegramId,
      plan: months === 12 ? '12-month' : (months === 3 ? '3-month' : '1-month'),
      status: 'active',
      expires_at: expiresAt
    });
  } catch (_) {}

  return expiresAt;
}

async function revokeUserPro(telegramId) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('users')
    .update({
      is_pro: false,
      pro_status: 'expired',
      pro_expires_at: now,
      pro_until: now
    })
    .eq('telegram_id', telegramId);
  return !error;
}

app.post('/api/admin/subscriptions/grant', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const telegramId = validatePositiveInteger(req.body.telegramId);
  const months = validatePositiveInteger(req.body.months, 36);
  if (!telegramId || !months) return sendError(res, 400, 'Telegram ID va 1–36 oylik muddat kiriting.');
  try {
    const { data, error } = await supabase.rpc('grant_pro_subscription', {
      p_telegram_id: telegramId,
      p_duration_months: months,
      p_source: req.body.promo ? 'admin_promo' : 'admin_manual',
      p_note: String(req.body.note || '').slice(0, 500) || null
    });
    if (!error && data) return res.json({ ok: true, expiresAt: data });
  } catch (_) {}

  try {
    const expiresAt = await grantUserPro(telegramId, months, req.body.promo ? 'admin_promo' : 'admin_manual', req.body.note);
    return res.json({ ok: true, expiresAt });
  } catch (error) {
    console.error('PRO obunasini berish xatosi:', error.message);
    return sendError(res, 400, 'Obunani faollashtirib bo‘lmadi.');
  }
});

app.post('/api/admin/subscriptions/extend', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const telegramId = validatePositiveInteger(req.body.telegramId);
  const months = validatePositiveInteger(req.body.months, 36);
  if (!telegramId || !months) return sendError(res, 400, 'Telegram ID va 1–36 oylik muddat kiriting.');
  try {
    const { data, error } = await supabase.rpc('grant_pro_subscription', {
      p_telegram_id: telegramId,
      p_duration_months: months,
      p_source: 'admin_extension',
      p_note: String(req.body.note || '').slice(0, 500) || null
    });
    if (!error && data) return res.json({ ok: true, expiresAt: data });
  } catch (_) {}

  try {
    const expiresAt = await grantUserPro(telegramId, months, 'admin_extension', req.body.note);
    return res.json({ ok: true, expiresAt });
  } catch (error) {
    console.error('Obunani uzaytirish xatosi:', error.message);
    return sendError(res, 400, 'Obunani uzaytirib bo‘lmadi.');
  }
});

app.post('/api/admin/subscriptions/revoke', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const telegramId = validatePositiveInteger(req.body.telegramId);
  if (!telegramId) return sendError(res, 400, 'Telegram ID noto‘g‘ri.');
  try {
    const { data, error } = await supabase.rpc('revoke_pro_subscription', { p_telegram_id: telegramId });
    if (!error && typeof data !== 'undefined') return res.json({ ok: Boolean(data) });
  } catch (_) {}

  try {
    const ok = await revokeUserPro(telegramId);
    return res.json({ ok });
  } catch (error) {
    console.error('Obunani bekor qilish xatosi:', error.message);
    return sendError(res, 503, 'Obunani bekor qilib bo‘lmadi.');
  }
});

app.patch('/api/admin/plans/:id', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const price = validatePositiveInteger(req.body.priceUzs, 1000000000);
  const months = validatePositiveInteger(req.body.durationMonths, 36);
  if (!price || price < 1000 || !months) {
    return sendError(res, 400, 'Narx kamida 1 000 UZS, muddat esa 1–36 oy bo‘lishi kerak.');
  }
  const updates = {
    price_uzs: price,
    duration_months: months,
    updated_at: new Date().toISOString()
  };
  if (typeof req.body.active === 'boolean') updates.active = req.body.active;
  const { data, error } = await supabase.from('subscription_plans')
    .update(updates).eq('id', req.params.id)
    .select('id, name, duration_months, price_uzs, active').maybeSingle();
  if (error) return sendError(res, 503, 'Tarifni yangilab bo‘lmadi.');
  if (!data) return sendError(res, 404, 'Tarif topilmadi.');
  return res.json(data);
});

app.post('/api/admin/settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof value === 'undefined') return sendError(res, 400, 'Kalit va qiymat kerak.');
  const { error } = await supabase.from('app_settings')
    .upsert({ key: String(key), value: String(value) });
  if (error) return sendError(res, 503, 'Sozlamani saqlab bo‘lmadi.');
  return res.json({ ok: true });
});

app.get('/api/admin/stats', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  try {
    const [
      { count: userCount, error: countError },
      { count: activeUserCount, error: activeError },
      { count: proCount, error: proError },
      { count: pendingPayments, error: pendingError },
      { count: reviewPayments, error: reviewError },
      { count: rejectedPayments, error: rejectedError },
      { count: approvedPayments, error: approvedError },
      { data: users, error: usersError }
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true })
        .gte('last_active_at', new Date(Date.now() - 30 * 86400000).toISOString()),
      supabase.from('subscriptions').select('*', { count: 'exact', head: true })
        .eq('status', 'active').gt('expires_at', new Date().toISOString()),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'review'),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'rejected'),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'paid'),
      supabase.from('users').select('telegram_id, first_name, username, is_pro, pro_until, pro_expires_at, last_active_at, created_at')
        .order('created_at', { ascending: false }).limit(20)
    ]);
    if (countError) throw countError;
    if (activeError) throw activeError;
    if (proError) throw proError;
    if (pendingError) throw pendingError;
    if (reviewError) throw reviewError;
    if (rejectedError) throw rejectedError;
    if (approvedError) throw approvedError;
    if (usersError) throw usersError;

    let totalRevenueUzs = 0;
    try {
      const revRes = await supabase.rpc('subscription_revenue');
      if (!revRes.error && revRes.data) totalRevenueUzs = Number(revRes.data.totalUzs) || 0;
    } catch (_) {}
    if (!totalRevenueUzs) {
      try {
        const { data: paidPayments } = await supabase.from('payments').select('amount_uzs').eq('status', 'paid');
        totalRevenueUzs = (paidPayments || []).reduce((acc, p) => acc + (Number(p.amount_uzs) || 0), 0);
      } catch (_) {}
    }

    return res.json({
      userCount,
      activeUserCount,
      proCount,
      pendingPayments,
      reviewPayments,
      rejectedPayments,
      approvedPayments,
      totalRevenueUzs,
      users
    });
  } catch (error) {
    console.error('Admin statistikasi xatosi:', error.message);
    return sendError(res, 503, 'Statistikani yuklab bo‘lmadi.');
  }
});

app.post('/api/admin/broadcast', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 4000) return sendError(res, 400, 'Xabar 1–4000 belgi bo‘lishi kerak.');
  if (!BOT_TOKEN) return sendError(res, 503, 'Telegram bot tokeni sozlanmagan.');
  const { data: users, error } = await supabase.from('users').select('telegram_id');
  if (error) return sendError(res, 503, 'Foydalanuvchilarni yuklab bo‘lmadi.');
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegram_id, text: message })
    });
    if (response.ok) sent++;
    else failed++;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return res.json({ ok: failed === 0, sent, failed });
});

// The authenticated identity is authoritative; clients do not choose a user ID.
app.get('/api/transactions', requireDatabase, requireTelegram, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('*')
    .eq('user_id', req.user.id).order('date', { ascending: false });
  if (error) {
    console.error('Operatsiyalarni yuklab olish xatosi:', error.message);
    return sendError(res, 503, 'Operatsiyalarni yuklab bo‘lmadi.');
  }
  return res.json(data);
});

// Keep the scoped legacy route for older clients.
app.get('/api/transactions/:userId', requireDatabase, requireTelegram, async (req, res) => {
  if (String(req.user.id) !== String(req.params.userId)) return sendError(res, 403, 'Ruxsat yo‘q.');
  const { data, error } = await supabase.from('transactions').select('*')
    .eq('user_id', req.user.id).order('date', { ascending: false });
  if (error) {
    console.error('Operatsiyalarni yuklab olish xatosi:', error.message);
    return sendError(res, 503, 'Operatsiyalarni yuklab bo‘lmadi.');
  }
  return res.json(data);
});

app.post('/api/transactions', requireDatabase, requireTelegram, async (req, res) => {
  const type = String(req.body.type || '');
  const amount = Number(req.body.amount);
  const category = String(req.body.category || '').slice(0, 100);
  const note = String(req.body.note || '').slice(0, 500);
  const clientId = String(req.body.clientId || '').slice(0, 100);
  const date = req.body.date ? new Date(req.body.date) : new Date();
  if (!['income', 'expense'].includes(type) || !Number.isSafeInteger(amount) || amount <= 0 || !category) {
    return sendError(res, 400, 'Operatsiya ma’lumotlari noto‘g‘ri.');
  }
  if (req.body.date && Number.isNaN(date.getTime())) return sendError(res, 400, 'Operatsiya sanasi noto‘g‘ri.');
  if (req.body.clientId && !clientId) return sendError(res, 400, 'Operatsiya identifikatori noto‘g‘ri.');
  const transaction = { user_id: req.user.id, type, amount, category, note, date: date.toISOString() };
  if (clientId) transaction.client_id = clientId;
  
  let data = null;
  let saveError = null;

  if (clientId) {
    try {
      const upsertRes = await supabase.from('transactions')
        .upsert(transaction, { onConflict: 'user_id,client_id' })
        .select()
        .single();
      if (!upsertRes.error && upsertRes.data) {
        data = upsertRes.data;
      } else {
        saveError = upsertRes.error;
      }
    } catch (e) {
      saveError = e;
    }
  }

  // Agar client_id ustuni yoki unikal index bo'lmasa, client_idsiz xavfsiz insert qilish
  if (!data) {
    delete transaction.client_id;
    const insertRes = await supabase.from('transactions')
      .insert(transaction)
      .select()
      .single();
    if (insertRes.error) {
      console.error('Operatsiyani saqlash xatosi:', insertRes.error.message);
      return sendError(res, 503, 'Operatsiyani saqlab bo‘lmadi.');
    }
    data = insertRes.data;
  }

  return res.status(201).json(data);
});

app.delete('/api/transactions/:id', requireDatabase, requireTelegram, async (req, res) => {
  const { error, count } = await supabase.from('transactions').delete({ count: 'exact' })
    .eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return sendError(res, 503, 'Operatsiyani o‘chirib bo‘lmadi.');
  if (!count) return sendError(res, 404, 'Operatsiya topilmadi.');
  return res.json({ ok: true });
});

app.get('/api/settings', requireDatabase, requireTelegram, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('app_settings').select('*');
  if (error) return sendError(res, 503, 'Sozlamalarni yuklab bo‘lmadi.');
  const settings = {};
  data.forEach(item => {
    if (!/(secret|token|key|password|credential|merchant)/i.test(item.key)) {
      settings[item.key] = item.value;
    }
  });
  return res.json(settings);
});

// Receipt images are not proof of payment and cannot activate a subscription.
app.post('/api/pro/request', (req, res) => sendError(
  res,
  410,
  'PRO xaridi uchun tarifni tanlab, chekni yuboring. Obuna faqat administrator tasdiqlagandan keyin faollashadi.'
));

// ==========================================
// OILAVIY HAMYON (SHARED FAMILY WALLET)
// ==========================================

async function getFamilyWalletByTelegramId(telegramId) {
  const { data: userRef } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'family_user:' + telegramId)
    .maybeSingle();

  if (!userRef || !userRef.value) return null;
  const walletId = userRef.value;

  const { data: walletData } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'family_wallet:' + walletId)
    .maybeSingle();

  if (!walletData || !walletData.value) return null;
  try {
    return JSON.parse(walletData.value);
  } catch (_) {
    return null;
  }
}

async function saveFamilyWallet(wallet) {
  await supabase
    .from('app_settings')
    .upsert({
      key: 'family_wallet:' + wallet.id,
      value: JSON.stringify(wallet),
      updated_at: new Date().toISOString()
    });
}

app.get('/api/family/my', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const telegramId = req.user.telegram_id;
    const wallet = await getFamilyWalletByTelegramId(telegramId);
    if (!wallet) return res.json({ wallet: null });

    const memberTgIds = (wallet.members || []).map(m => m.telegramId);
    const { data: userRows } = await supabase
      .from('users')
      .select('id, telegram_id, first_name, username')
      .in('telegram_id', memberTgIds);

    const userMap = new Map((userRows || []).map(u => [u.telegram_id, u]));
    const memberUserIds = (userRows || []).map(u => u.id);

    const now = new Date();
    const monthStart = new Date(Date.now());
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    let memberTxs = [];
    if (memberUserIds.length > 0) {
      const { data: txs } = await supabase
        .from('transactions')
        .select('*')
        .in('user_id', memberUserIds)
        .gte('date', monthStart.toISOString())
        .order('date', { ascending: false });
      memberTxs = txs || [];
    }

    const idToTgMap = new Map((userRows || []).map(u => [u.id, u.telegram_id]));
    const memberSpentMap = {};
    let totalSpentMonth = 0;

    for (const tx of memberTxs) {
      if (tx.type === 'expense') {
        const tgId = idToTgMap.get(tx.user_id);
        const amt = Number(tx.amount) || 0;
        totalSpentMonth += amt;
        if (tgId) {
          memberSpentMap[tgId] = (memberSpentMap[tgId] || 0) + amt;
        }
      }
    }

    const budgetMonthly = Number(wallet.budgetMonthly) || 0;
    const budgetRemaining = Math.max(0, budgetMonthly - totalSpentMonth);
    const spentPercent = budgetMonthly > 0 ? Math.min(100, Math.round((totalSpentMonth / budgetMonthly) * 100)) : 0;

    let minSpent = Infinity;
    let minMemberId = null;

    const membersStats = (wallet.members || []).map(m => {
      const u = userMap.get(m.telegramId);
      const spent = memberSpentMap[m.telegramId] || 0;
      if (spent < minSpent) {
        minSpent = spent;
        minMemberId = m.telegramId;
      }
      return {
        telegramId: m.telegramId,
        name: m.name || (u && u.first_name) || 'Oila a’zosi',
        role: m.role || 'member',
        spent,
        percentOfTotal: totalSpentMonth > 0 ? Math.round((spent / totalSpentMonth) * 100) : 0,
        percentOfBudget: budgetMonthly > 0 ? Math.round((spent / budgetMonthly) * 100) : 0
      };
    });

    if (totalSpentMonth > 0 && minMemberId) {
      for (const m of membersStats) {
        if (m.telegramId === minMemberId) {
          m.isChampion = true;
        }
      }
    }

    const recentTransactions = memberTxs.slice(0, 20).map(tx => {
      const tgId = idToTgMap.get(tx.user_id);
      const u = tgId ? userMap.get(tgId) : null;
      return {
        ...tx,
        memberName: (u && u.first_name) || 'Oila a’zosi'
      };
    });

    return res.json({
      wallet: {
        id: wallet.id,
        name: wallet.name,
        inviteCode: wallet.inviteCode,
        isOwner: wallet.ownerTelegramId === telegramId,
        ownerTelegramId: wallet.ownerTelegramId,
        budgetMonthly,
        totalSpentMonth,
        budgetRemaining,
        spentPercent,
        membersCount: (wallet.members || []).length,
        members: membersStats,
        recentTransactions
      }
    });
  } catch (error) {
    console.error('Oilaviy hamyonni olish xatosi:', error.message);
    return sendError(res, 500, 'Oilaviy hamyonni yuklab bo‘lmadi.');
  }
});

app.post('/api/family/create', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const telegramId = req.user.telegram_id;
    const existing = await getFamilyWalletByTelegramId(telegramId);
    if (existing) {
      return sendError(res, 400, 'Siz allaqachon oilaviy hamyon a’zosisiz. Avval undan chiqing.');
    }

    const name = String(req.body.name || 'Bizning Oila').trim().slice(0, 60) || 'Bizning Oila';
    const budgetMonthly = validatePositiveInteger(req.body.budgetMonthly, 100000000000) || 5000000;
    const walletId = 'fam_' + Math.random().toString(36).slice(2, 10);
    const inviteCode = 'OILA-' + Math.floor(1000 + Math.random() * 9000);

    const callerName = req.user.first_name || 'Boshqaruvchi';
    const wallet = {
      id: walletId,
      name,
      budgetMonthly,
      inviteCode,
      ownerTelegramId: telegramId,
      createdAt: new Date().toISOString(),
      members: [
        {
          telegramId,
          name: callerName,
          role: 'owner',
          joinedAt: new Date().toISOString()
        }
      ]
    };

    await saveFamilyWallet(wallet);

    await supabase.from('app_settings').upsert({
      key: 'family_user:' + telegramId,
      value: walletId,
      updated_at: new Date().toISOString()
    });

    await supabase.from('app_settings').upsert({
      key: 'family_invite:' + inviteCode,
      value: walletId,
      updated_at: new Date().toISOString()
    });

    return res.status(201).json({ ok: true, wallet });
  } catch (error) {
    console.error('Oilaviy hamyon yaratish xatosi:', error.message);
    return sendError(res, 500, 'Oilaviy hamyon yaratib bo‘lmadi.');
  }
});

app.post('/api/family/join', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const telegramId = req.user.telegram_id;
    const existing = await getFamilyWalletByTelegramId(telegramId);
    if (existing) {
      return sendError(res, 400, 'Siz allaqachon oilaviy hamyon a’zosisiz.');
    }

    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!code) return sendError(res, 400, 'Taklif kodini kiriting.');

    const { data: codeRow } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'family_invite:' + code)
      .maybeSingle();

    if (!codeRow || !codeRow.value) {
      return sendError(res, 404, 'Taklif kodi topilmadi yoki eskirgan.');
    }

    const walletId = codeRow.value;
    const { data: walletData } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'family_wallet:' + walletId)
      .maybeSingle();

    if (!walletData || !walletData.value) {
      return sendError(res, 404, 'Oilaviy hamyon topilmadi.');
    }

    const wallet = JSON.parse(walletData.value);
    const alreadyMember = (wallet.members || []).some(m => m.telegramId === telegramId);
    if (alreadyMember) {
      return sendError(res, 400, 'Siz allaqachon ushbu oila a’zosisiz.');
    }

    if ((wallet.members || []).length >= 10) {
      return sendError(res, 400, 'Oilaviy hamyonga ko‘pi bilan 10 ta a’zo qo‘shilishi mumkin.');
    }

    wallet.members.push({
      telegramId,
      name: req.user.first_name || 'Oila a’zosi',
      role: 'member',
      joinedAt: new Date().toISOString()
    });

    await saveFamilyWallet(wallet);

    await supabase.from('app_settings').upsert({
      key: 'family_user:' + telegramId,
      value: walletId,
      updated_at: new Date().toISOString()
    });

    return res.json({ ok: true, wallet });
  } catch (error) {
    console.error('Oila hamyoniga qo‘shilish xatosi:', error.message);
    return sendError(res, 500, 'Oilaviy hamyonga qo‘shilib bo‘lmadi.');
  }
});

app.post('/api/family/leave', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const telegramId = req.user.telegram_id;
    const wallet = await getFamilyWalletByTelegramId(telegramId);
    if (!wallet) return sendError(res, 400, 'Siz oilaviy hamyonda emassiz.');

    wallet.members = (wallet.members || []).filter(m => m.telegramId !== telegramId);

    if (wallet.members.length === 0 || wallet.ownerTelegramId === telegramId) {
      for (const m of (wallet.members || [])) {
        await supabase.from('app_settings').delete().eq('key', 'family_user:' + m.telegramId);
      }
      await supabase.from('app_settings').delete().eq('key', 'family_wallet:' + wallet.id);
      await supabase.from('app_settings').delete().eq('key', 'family_invite:' + wallet.inviteCode);
    } else {
      await saveFamilyWallet(wallet);
    }

    await supabase.from('app_settings').delete().eq('key', 'family_user:' + telegramId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Oilaviy hamyondan chiqish xatosi:', error.message);
    return sendError(res, 500, 'Oilaviy hamyondan chiqib bo‘lmadi.');
  }
});

app.post('/api/family/update', requireDatabase, requireTelegram, async (req, res) => {
  try {
    const telegramId = req.user.telegram_id;
    const wallet = await getFamilyWalletByTelegramId(telegramId);
    if (!wallet) return sendError(res, 404, 'Oilaviy hamyon topilmadi.');
    if (wallet.ownerTelegramId !== telegramId) {
      return sendError(res, 403, 'Faqat oilaviy hamyon egasi byudjetni o‘zgartirishi mumkin.');
    }

    if (req.body.name) {
      wallet.name = String(req.body.name).trim().slice(0, 60);
    }
    if (req.body.budgetMonthly) {
      const budget = validatePositiveInteger(req.body.budgetMonthly, 100000000000);
      if (budget) wallet.budgetMonthly = budget;
    }

    await saveFamilyWallet(wallet);
    return res.json({ ok: true, wallet });
  } catch (error) {
    console.error('Oila sozlamalarini yangilash xatosi:', error.message);
    return sendError(res, 500, 'Oila sozlamalarini yangilab bo‘lmadi.');
  }
});

app.use('/api', (req, res) => sendError(res, 404, 'API endpoint topilmadi.'));

app.use((error, req, res, next) => {
  console.error('Kutilmagan server xatosi:', error.message);
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      error.code === 'LIMIT_FILE_SIZE' ? 'Chek rasmi 5 MB dan oshmasligi kerak.' : 'Rasm faylini yuklab bo‘lmadi.');
  }
  if (error.message === 'Chek uchun JPG, PNG yoki WebP rasm tanlang.') {
    return sendError(res, 400, error.message);
  }
  return sendError(res, 500, 'Serverda kutilmagan xatolik yuz berdi.');
});

if (require.main === module) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BOT_TOKEN || !process.env.BOT_INTERNAL_SECRET) {
    console.error('Ishga tushmadi: Supabase, Telegram bot tokeni va ichki bot secret sozlamalarini kiriting.');
    process.exitCode = 1;
  } else {
    app.listen(PORT, () => console.log('Xarajat AI serveri ' + PORT + '-portda ishlayapti.'));
  }
}

module.exports = {
  app,
  checkAiRateLimit,
  checkPaymeAuth,
  enqueueAiRequest,
  getTelegramIdentity,
  hasActiveReceiptPro,
  requireReceiptPro,
  requestGemini,
  requestGeminiWithImage,
  parseReceiptVisionData,
  receiptMimeMatches
};
if (require.main === module) {
  require('./bot.js').startBot().catch(err => console.error('Bot xatosi:', err));
}
const test = require('node:test');
const assert = require('node:assert/strict');

const originalAdminId = process.env.ADMIN_ID;
const originalBotToken = process.env.BOT_TOKEN;
const originalBackendUrl = process.env.BACKEND_URL;
process.env.ADMIN_ID = '9001';
process.env.BOT_TOKEN = 'test-bot-token';
process.env.BACKEND_URL = 'http://backend.test';
const {
  grantSubscriptionDirectly,
  handleCallbackQuery,
  handlePaymentReceipt,
  handleStart,
  handleLanguageCommand,
  getUserLanguage,
  setUserLanguage,
  TRANSLATIONS
} = require('../bot');
if (originalAdminId === undefined) delete process.env.ADMIN_ID;
else process.env.ADMIN_ID = originalAdminId;
if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
else process.env.BOT_TOKEN = originalBotToken;
if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
else process.env.BACKEND_URL = originalBackendUrl;

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

function approvalDatabase(currentExpiry, payment = null, optionalTablesMissing = false) {
  const updates = [];
  const subscriptions = [];
  const database = {
    updates,
    subscriptions,
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => ({
          data: table === 'users'
            ? { telegram_id: 12345, pro_until: currentExpiry, pro_expires_at: currentExpiry }
            : payment,
          error: optionalTablesMissing && table === 'payments'
            ? { code: 'PGRST205', message: 'payments table not found' }
            : null
        }),
        update(values) {
          updates.push({ table, values });
          return this;
        },
        upsert(values, options) {
          if (table === 'users') updates.push({ table, values, options });
          else subscriptions.push(values);
          return Promise.resolve({
            error: optionalTablesMissing && table === 'subscriptions'
              ? { code: 'PGRST205', message: 'subscriptions table not found' }
              : null
          });
        },
        then(resolve, reject) {
          return Promise.resolve({
            error: optionalTablesMissing && table === 'payments'
              ? { code: 'PGRST205', message: 'payments table not found' }
              : null
          }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  return database;
}

test('payment receipt is sent to admins with approve and reject buttons when receipt API fails', async () => {
  const originalFetch = global.fetch;
  const telegramCalls = [];
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('http://backend.test/api/payments/history')) {
      return jsonResponse([{
        id: 'payment-id',
        provider: 'manual',
        status: 'pending',
        plan_id: '3-month',
        amount_uzs: 44990
      }]);
    }
    if (url === 'http://backend.test/api/payments/payment-id/receipt') {
      return jsonResponse({ error: 'API endpoint topilmadi.' }, 404);
    }
    if (url.endsWith('/getFile')) {
      return jsonResponse({ ok: true, result: { file_path: 'photos/receipt.jpg', file_size: 100 } });
    }
    if (url.includes('/file/bot')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    const method = url.split('/').pop();
    telegramCalls.push({ method, payload: JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handlePaymentReceipt({
      chat: { id: 12345 },
      from: { id: 12345, first_name: 'Test user' },
      caption: 'plan=3-month',
      photo: [{ file_id: 'telegram-file-id' }]
    });
    const sentPhoto = telegramCalls.find(call => call.method === 'sendPhoto');
    assert.ok(sentPhoto);
    assert.equal(sentPhoto.payload.chat_id, '9001');
    assert.equal(sentPhoto.payload.photo, 'telegram-file-id');
    assert.deepEqual(sentPhoto.payload.reply_markup.inline_keyboard[0].map(button => button.callback_data), [
      'approve_12345_3-month',
      'reject_12345'
    ]);
    assert.match(sentPhoto.payload.caption, /3 oylik PRO obunasi uchun ariza keldi/);
    assert.ok(telegramCalls.some(call =>
      call.method === 'sendMessage' &&
      call.payload.text === '✅ Chekingiz qabul qilindi va administratorga yuborildi. Tasdiqlanishi bilan obunangiz faollashadi.'
    ));
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    global.fetch = originalFetch;
  }
});

test('stored receipt shows the requested months and approval button processes only once', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const paymentId = '123e4567-e89b-42d3-a456-426614174000';
  global.fetch = async (url, options = {}) => {
    const body = options.body instanceof FormData
      ? null
      : options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method || 'GET', body });
    if (url.startsWith('http://backend.test/api/payments/history')) {
      return jsonResponse([{
        id: paymentId,
        provider: 'manual',
        status: 'pending',
        plan_id: '3-month',
        duration_months: 6,
        amount_uzs: 89990
      }]);
    }
    if (url.endsWith('/getFile')) {
      return jsonResponse({ ok: true, result: { file_path: 'photos/receipt.jpg', file_size: 100 } });
    }
    if (url.includes('/file/bot')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    if (url === 'http://backend.test/api/payments/' + paymentId + '/receipt') {
      return jsonResponse({ ok: true, status: 'review' });
    }
    if (url === 'http://backend.test/api/admin/payments/' + paymentId + '/approve') {
      return jsonResponse({ ok: true, alreadyProcessed: false });
    }
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handlePaymentReceipt({
      chat: { id: 12345 },
      from: { id: 12345, first_name: 'Test user' },
      photo: [{ file_id: 'telegram-file-id' }]
    });
    const sentPhoto = requests.find(request => request.url.includes('/sendPhoto'));
    assert.match(sentPhoto.body.caption, /6 oylik PRO obunasi uchun ariza keldi/);
    assert.match(sentPhoto.body.caption, new RegExp('To‘lov ID: ' + paymentId));
    assert.equal(
      sentPhoto.body.reply_markup.inline_keyboard[0][0].callback_data,
      'approve_12345_months_6'
    );

    const callback = {
      id: 'single-use-callback',
      from: { id: 9001 },
      data: 'approve_12345_months_6',
      message: { chat: { id: '9001' }, message_id: 501, caption: sentPhoto.body.caption }
    };
    await Promise.all([
      handleCallbackQuery(callback),
      handleCallbackQuery(Object.assign({}, callback, { id: 'duplicate-callback' }))
    ]);

    assert.equal(requests.filter(request =>
      request.url === 'http://backend.test/api/admin/payments/' + paymentId + '/approve'
    ).length, 1);
    assert.ok(requests.some(request =>
      request.url.includes('/editMessageReplyMarkup') &&
      request.body.reply_markup.inline_keyboard.length === 0
    ));
  } finally {
    global.fetch = originalFetch;
  }
});

test('payment receipt without a known plan gives admins the four duration choices', async () => {
  const originalFetch = global.fetch;
  const telegramCalls = [];
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('http://backend.test/api/payments/history')) {
      return jsonResponse({ error: 'Server xatosi' }, 503);
    }
    telegramCalls.push({ method: url.split('/').pop(), payload: JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handlePaymentReceipt({
      chat: { id: 12345 },
      from: { id: 12345 },
      photo: [{ file_id: 'telegram-file-id' }]
    });
    const sentPhoto = telegramCalls.find(call => call.method === 'sendPhoto');
    assert.deepEqual(sentPhoto.payload.reply_markup.inline_keyboard.map(row =>
      row.map(button => button.text)), [
      ['✅ 1 Oylik PRO', '✅ 3 Oylik PRO'],
      ['✅ 6 Oylik PRO', '✅ 1 Yillik PRO'],
      ['❌ Rad etish']
    ]);
    assert.deepEqual(sentPhoto.payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data), [
      'approve_12345_days_30',
      'approve_12345_days_90',
      'approve_12345_days_180',
      'approve_12345_days_365',
      'reject_12345'
    ]);
    assert.ok(telegramCalls.some(call =>
      call.method === 'sendMessage' &&
      call.payload.text === '✅ Chekingiz qabul qilindi va administratorga yuborildi. Tasdiqlanishi bilan obunangiz faollashadi.'
    ));
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    global.fetch = originalFetch;
  }
});

test('start message defaults to FREE when backend authentication fails', async () => {
  const originalFetch = global.fetch;
  let startMessage;
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('http://backend.test/api/auth')) return jsonResponse({ error: 'Server xatosi' }, 503);
    startMessage = JSON.parse(options.body);
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleStart({ chat: { id: 12345 }, from: { id: 12345, first_name: 'Test user' } });
    assert.match(startMessage.text, /FREE tarif/);
    assert.doesNotMatch(startMessage.text, /Obuna holatini yuklab bo‘lmadi/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin approve callback grants the requested plan duration', async () => {
  const originalFetch = global.fetch;
  const telegramCalls = [];
  const requestUrls = [];
  const database = approvalDatabase(null, { id: 'payment-id', provider_data: {} });
  global.fetch = async (url, options = {}) => {
    requestUrls.push(url);
    const method = url.split('/').pop();
    telegramCalls.push({ method, ...JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleCallbackQuery({
      id: 'callback-id',
      from: { id: ' 9001 ' },
      data: 'approve_12345_3-month',
      message: { chat: { id: 9001 }, message_id: 7, caption: 'PRO to‘lov cheki' }
    }, database);
    const userUpdate = database.updates.find(update => update.table === 'users').values;
    assert.equal(userUpdate.is_pro, true);
    assert.equal(userUpdate.pro_status, 'pro');
    assert.ok(Date.parse(userUpdate.pro_until) > Date.now() + 89 * 86400000);
    assert.deepEqual(Object.keys(userUpdate).sort(),
      ['is_pro', 'pro_expires', 'pro_expires_at', 'pro_status', 'pro_until', 'telegram_id']);
    assert.equal(userUpdate.telegram_id, '12345');
    assert.deepEqual(database.updates.find(update => update.table === 'users').options,
      { onConflict: 'telegram_id' });
    assert.equal(database.updates.find(update => update.table === 'payments').values.status, 'paid');
    assert.equal(database.subscriptions[0].expires_at,
      userUpdate.pro_until);
    assert.equal(database.subscriptions[0].ends_at, userUpdate.pro_expires_at);
    assert.ok(telegramCalls.some(request => request.chat_id === 12345 &&
      /^🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: \d{2}\.\d{2}\.\d{4} gacha$/.test(request.text)));
    assert.ok(telegramCalls.some(request => request.method === 'editMessageCaption' &&
      /✅ PRO obuna faollashtirildi!/.test(request.caption) &&
      request.reply_markup.inline_keyboard.length === 0));
    assert.equal(telegramCalls[0].method, 'answerCallbackQuery');
    assert.equal(telegramCalls[0].text, undefined);
    assert.ok(requestUrls.every(url => url.startsWith('https://api.telegram.org/')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin approval can resolve the target user from the receipt caption', async () => {
  const originalFetch = global.fetch;
  const database = approvalDatabase(null);
  const telegramCalls = [];
  global.fetch = async (url, options = {}) => {
    telegramCalls.push({ method: url.split('/').pop(), ...JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleCallbackQuery({
      id: 'callback-caption-user',
      from: { id: 9001 },
      data: 'approve_days_30',
      message: {
        chat: { id: 9001 },
        message_id: 8,
        caption: 'PRO to‘lov cheki\nFoydalanuvchi ID: 12345'
      }
    }, database);
    assert.ok(Date.parse(database.updates.find(update => update.table === 'users').values.pro_until) > Date.now() + 29 * 86400000);
    assert.ok(telegramCalls.some(request => request.chat_id === 12345 &&
      /^🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: \d{2}\.\d{2}\.\d{4} gacha$/.test(request.text)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin approve callback defaults unknown duration to one month', async () => {
  const originalFetch = global.fetch;
  const database = approvalDatabase(null);
  const telegramCalls = [];
  global.fetch = async (url, options = {}) => {
    const method = url.split('/').pop();
    telegramCalls.push({ method, ...JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleCallbackQuery({
      id: 'callback-id',
      from: { id: 9001 },
      data: 'approve_12345_unknown'
    }, database);
    assert.ok(Date.parse(database.updates.find(update => update.table === 'users').values.pro_until) > Date.now() + 29 * 86400000);
    assert.ok(telegramCalls.some(request => request.chat_id === 12345 &&
      /^🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: \d{2}\.\d{2}\.\d{4} gacha$/.test(request.text)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin approval succeeds when optional subscription and payment tables are missing', async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const telegramCalls = [];
  const loggedErrors = [];
  const database = approvalDatabase(null, null, true);
  console.error = (...args) => loggedErrors.push(args);
  global.fetch = async (url, options = {}) => {
    const method = url.split('/').pop();
    telegramCalls.push({ method, ...JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleCallbackQuery({
      id: 'callback-optional-tables-missing',
      from: { id: 9001 },
      data: 'approve_12345_days_30',
      message: { chat: { id: 9001 }, message_id: 9 }
    }, database);
    const userUpdate = database.updates.find(update => update.table === 'users');
    assert.equal(userUpdate.values.is_pro, true);
    assert.equal(userUpdate.values.pro_status, 'pro');
    assert.equal(userUpdate.values.telegram_id, '12345');
    assert.ok(loggedErrors.some(args => args[0] === 'Obuna jadvalini sinxronlab bo‘lmadi:'));
    assert.ok(loggedErrors.some(args => args[0] === 'Manual to‘lov holatini yangilab bo‘lmadi:'));
    assert.ok(telegramCalls.some(call => call.chat_id === 12345 &&
      /^🎉 PRO obunangiz faollashtirildi! Amal qilish muddati: \d{2}\.\d{2}\.\d{4} gacha$/.test(call.text)));
    assert.ok(telegramCalls.some(call => call.method === 'editMessageReplyMarkup'));
  } finally {
    console.error = originalConsoleError;
    global.fetch = originalFetch;
  }
});

test('admin duration buttons map 30, 90, 180, and 365 days to the corresponding PRO terms', async () => {
  const originalFetch = global.fetch;
  const grantedDays = [];
  global.fetch = async (url, options = {}) => {
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    for (const [days, months] of [[30, 1], [90, 3], [180, 6], [365, 12]]) {
      const database = approvalDatabase(null);
      await handleCallbackQuery({
        id: 'callback-' + days,
        from: { id: 9001 },
        data: 'approve_12345_days_' + days
      }, database);
      const userUpdate = database.updates.find(update => update.table === 'users');
      grantedDays.push(Math.round((Date.parse(userUpdate.values.pro_until) - Date.now()) / 86400000));
    }
    assert.deepEqual(grantedDays, [30, 90, 180, 365]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('direct subscription fallback stacks exact days and synchronizes subscription records', async () => {
  const now = Date.now();
  const currentExpiry = new Date(now + 5 * 86400000).toISOString();
  const updates = [];
  let subscriptionRow;
  const database = {
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({
          data: { telegram_id: 12345, pro_until: currentExpiry, pro_expires_at: currentExpiry },
          error: null
        }),
        then(resolve, reject) {
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
        upsert(values, options) {
          if (table === 'users') updates.push({ table, values, options });
          else subscriptionRow = { table, values, options };
          return Promise.resolve({ error: null });
        }
      };
      return query;
    }
  };

  const expiry = await grantSubscriptionDirectly(12345, 90, 'days_90', database);
  assert.ok(Date.parse(expiry) >= now + 95 * 86400000 - 1000);
  assert.deepEqual(updates[0].values, {
    telegram_id: '12345',
    is_pro: true,
    pro_status: 'pro',
    pro_until: expiry,
    pro_expires: expiry,
    pro_expires_at: expiry
  });
  assert.equal(updates[0].table, 'users');
  assert.deepEqual(updates[0].options, { onConflict: 'telegram_id' });
  assert.equal(subscriptionRow.values.expires_at, expiry);
  assert.equal(subscriptionRow.values.ends_at, expiry);
  assert.equal(subscriptionRow.values.user_telegram_id, 12345);
});

test('admin reject callback closes the payment and notifies the user', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('http://backend.test/api/admin/payments/')) {
      requests.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ ok: true });
    }
    const method = url.split('/').pop();
    requests.push({ method, ...JSON.parse(options.body) });
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleCallbackQuery({
      id: 'callback-id',
      from: { id: 9001 },
      data: 'reject_12345',
      message: { caption: 'To‘lov ID: 123e4567-e89b-42d3-a456-426614174000' }
    });
    assert.equal(
      requests.find(request => request.url).url,
      'http://backend.test/api/admin/payments/123e4567-e89b-42d3-a456-426614174000/reject'
    );
    assert.ok(requests.some(request => request.chat_id === 12345 && /rad etildi/.test(request.text)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleLanguageCommand sends 3 language choices (O‘zbekcha, Русский, English)', async () => {
  const originalFetch = global.fetch;
  let sentPayload = null;
  global.fetch = async (url, options = {}) => {
    sentPayload = JSON.parse(options.body);
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    await handleLanguageCommand({ chat: { id: 77777 } });
    assert.ok(sentPayload);
    assert.equal(sentPayload.chat_id, 77777);
    const buttons = sentPayload.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    assert.ok(buttons.some(b => b.callback_data === 'setlang_uz'));
    assert.ok(buttons.some(b => b.callback_data === 'setlang_ru'));
    assert.ok(buttons.some(b => b.callback_data === 'setlang_en'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('setlang callback changes language and start displays chosen language', async () => {
  const originalFetch = global.fetch;
  const sentMessages = [];
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('http://backend.test/api/auth')) {
      return jsonResponse({ isPro: false }, 200);
    }
    const body = JSON.parse(options.body);
    sentMessages.push(body);
    return jsonResponse({ ok: true, result: {} });
  };

  try {
    // Switch to Russian
    await handleCallbackQuery({
      id: 'cb-ru',
      from: { id: 88888, first_name: 'Ivan' },
      data: 'setlang_ru',
      message: { chat: { id: 88888 } }
    });
    const langRu = await getUserLanguage(88888);
    assert.equal(langRu, 'ru');
    assert.ok(sentMessages.some(m => /Язык успешно изменён/i.test(m.text)));
    assert.ok(sentMessages.some(m => /добро пожаловать/i.test(m.text)));

    // Switch to English
    sentMessages.length = 0;
    await handleCallbackQuery({
      id: 'cb-en',
      from: { id: 88888, first_name: 'John' },
      data: 'setlang_en',
      message: { chat: { id: 88888 } }
    });
    const langEn = await getUserLanguage(88888);
    assert.equal(langEn, 'en');
    assert.ok(sentMessages.some(m => /Language successfully changed/i.test(m.text)));
    assert.ok(sentMessages.some(m => /welcome to your smart personal finance assistant/i.test(m.text)));
  } finally {
    global.fetch = originalFetch;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  app,
  getTelegramIdentity,
  hasActiveReceiptPro,
  parseReceiptVisionData,
  requireReceiptPro,
  requestGemini,
  requestGeminiWithImage
} = require('../server');

test('receipt scanner PRO access requires an enabled database flag and unexpired term', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');
  assert.equal(hasActiveReceiptPro({ is_pro: true, pro_until: '2026-12-17T12:00:00.000Z' }, now), true);
  assert.equal(hasActiveReceiptPro({ is_pro: true, pro_expires_at: '2026-12-17T12:00:00.000Z' }, now), true);
  assert.equal(hasActiveReceiptPro({ is_pro: true, pro_until: '2026-11-16T12:00:00.000Z' }, now), false);
  assert.equal(hasActiveReceiptPro({ is_pro: true, pro_until: 'invalid' }, now), false);
  assert.equal(hasActiveReceiptPro({ is_pro: true }, now), true);
  assert.equal(hasActiveReceiptPro({ is_pro: false, pro_status: 'pro' }, now), false);
});

test('receipt scanner middleware returns the required 403 for FREE users', () => {
  let statusCode;
  let body;
  let nextCalled = false;
  const response = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; }
  };
  requireReceiptPro({ user: { is_pro: false } }, response, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.deepEqual(body, { error: 'Chek skaneri faqat PRO foydalanuvchilar uchun' });
  assert.equal(nextCalled, false);

  requireReceiptPro({
    user: { is_pro: true, pro_expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }
  }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

function createInitData(token, authDate, userId) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'test-query',
    user: JSON.stringify({ id: userId, first_name: 'Telegram' })
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', token).update('WebAppData').digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

test('AI requests use Google Gemini generateContent with the API key header', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.AI_API_KEY;
  const originalModel = process.env.AI_MODEL;
  let request;
  process.env.AI_API_KEY = 'test-gemini-key';
  delete process.env.AI_MODEL;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Gemini reply' }] } }]
      })
    };
  };

  try {
    assert.equal(await requestGemini('User question', 'System prompt'), 'Gemini reply');
    assert.equal(
      request.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent'
    );
    assert.equal(request.options.headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
      systemInstruction: { parts: [{ text: 'System prompt' }] },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
      generationConfig: { maxOutputTokens: 700 }
    });
    process.env.AI_MODEL = 'gemini-1.5-flash';
    await requestGemini('User question', 'System prompt');
    assert.equal(
      request.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent'
    );
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = originalModel;
  }
});

test('receipt Vision requests send image data with the configured Gemini API key', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.AI_API_KEY;
  let request;
  process.env.AI_API_KEY = 'test-gemini-key';
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"storeName":"Market","date":"2026-11-17","items":[{"name":"Non","price":5000}],"total":5000}' }] } }]
      })
    };
  };

  try {
    const content = await requestGeminiWithImage(Buffer.from('test-image'), 'image/jpeg');
    assert.match(request.url, /:generateContent$/);
    assert.equal(request.options.headers['x-goog-api-key'], 'test-gemini-key');
    const body = JSON.parse(request.options.body);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
    assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from('test-image').toString('base64'));
    assert.deepEqual(parseReceiptVisionData(content), {
      storeName: 'Market',
      date: '2026-11-17',
      items: [{ name: 'Non', price: 5000 }],
      total: 5000
    });
    assert.throws(() => parseReceiptVisionData('not JSON'));
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalApiKey;
  }
});

async function withServer(run) {
  const server = app.listen(0);
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('auth and dashboard APIs return JSON when Telegram authentication is absent', async () => {
  await withServer(async baseUrl => {
    const auth = await fetch(baseUrl + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.notEqual(auth.status, 404);
    assert.match(auth.headers.get('content-type'), /application\/json/);
    assert.ok([401, 503].includes(auth.status));
    assert.ok((await auth.json()).error);

    const dashboard = await fetch(baseUrl + '/api/transactions');
    assert.notEqual(dashboard.status, 404);
    assert.match(dashboard.headers.get('content-type'), /application\/json/);
    assert.ok([401, 503].includes(dashboard.status));
    assert.ok((await dashboard.json()).error);

    for (const route of ['/api/subscription/status', '/api/admin/stats']) {
      const response = await fetch(baseUrl + route, {
        headers: { 'X-Telegram-Id': '123456789' }
      });
      assert.equal(response.status, dashboard.status === 503 ? 503 : 401);
      assert.ok((await response.json()).error);
    }

    const spoofedId = await fetch(baseUrl + '/api/transactions', {
      headers: { 'X-Telegram-Id': '123456789' }
    });
    assert.equal(spoofedId.status, 401);
    assert.match(spoofedId.headers.get('content-type'), /application\/json/);
  });
});

test('Telegram initData header resolves only a signed, fresh user identity', () => {
  const token = process.env.BOT_TOKEN;
  assert.ok(token, 'BOT_TOKEN must be configured for Telegram auth verification');
  const now = Math.floor(Date.now() / 1000);
  const initData = createInitData(token, now, 987654321);
  const request = (headerName, value) => ({
    get(name) {
      if (name.toLowerCase() === headerName.toLowerCase()) return value;
      return undefined;
    }
  });

  assert.equal(getTelegramIdentity(request('x-telegram-init-data', initData)).telegramId, 987654321);
  assert.equal(getTelegramIdentity(request('authorization', 'tma ' + initData)).telegramId, 987654321);
  assert.equal(getTelegramIdentity(request('x-telegram-init-data', initData.replace('Telegram', 'Tampered'))), null);
  assert.equal(getTelegramIdentity(request('x-telegram-init-data', createInitData(token, now - 90000, 987654321))), null);
  assert.equal(getTelegramIdentity(request('x-telegram-init-data', createInitData(token, now + 120, 987654321))), null);
  assert.equal(getTelegramIdentity(request('x-telegram-init-data', '')), null);
});

test('unknown API routes return a JSON 404 response', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(baseUrl + '/api/not-a-route');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { error: 'API endpoint topilmadi.' });
  });
});

test('manual payment creation is registered at both supported API paths', async () => {
  await withServer(async baseUrl => {
    for (const route of ['/api/payments/create', '/api/payments']) {
      const response = await fetch(baseUrl + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: '1-month' })
      });
      assert.notEqual(response.status, 404, route + ' must be registered');
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.ok([401, 503].includes(response.status));
      assert.ok((await response.json()).error);
    }

    const scan = await fetch(baseUrl + '/api/receipts/scan', { method: 'POST' });
    assert.notEqual(scan.status, 404, 'receipt Vision route must be registered');
    assert.match(scan.headers.get('content-type'), /application\/json/);
    assert.ok([401, 503].includes(scan.status));
    assert.ok((await scan.json()).error);
  });
});

test('configured APP_ORIGIN allows Web App Authorization preflight without trailing-slash mismatch', async () => {
  const origin = new URL(process.env.APP_ORIGIN.split(',')[0].trim()).origin;
  await withServer(async baseUrl => {
    const response = await fetch(baseUrl + '/api/auth', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-telegram-init-data,content-type'
      }
    });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('access-control-allow-headers'), /x-telegram-init-data/i);
  });
});

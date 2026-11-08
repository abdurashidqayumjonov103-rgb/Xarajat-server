const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { enqueueAiRequest, receiptMimeMatches } = require('../server');
const {
  clickSignature,
  clickCheckoutUrl,
  aiUsageAllowed,
  paymeCheckoutUrl,
  subscriptionIsActive,
  verifyClickSignature,
  verifyTelegramInitData
} = require('../payments');

function createInitData(token, authDate) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: 123456789, first_name: 'Test' })
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', token).update('WebAppData').digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('Telegram initData accepts valid signatures and rejects changed or stale data', () => {
  const token = 'test-bot-token';
  const now = Math.floor(Date.now() / 1000);
  const initData = createInitData(token, now);
  assert.equal(verifyTelegramInitData(initData, token).id, 123456789);
  assert.equal(verifyTelegramInitData(initData.replace('Test', 'Tampered'), token), null);
  assert.equal(verifyTelegramInitData(initData, 'wrong-bot-token'), null);
  assert.equal(verifyTelegramInitData(createInitData(token, now - 90000), token), null);
});

test('Click callback signature covers the callback data and prepare id on completion', () => {
  const payload = {
    click_trans_id: '123456',
    service_id: '987',
    merchant_trans_id: 'payment-id',
    amount: '29000',
    action: '1',
    sign_time: '2026-11-04 10:00:00',
    click_prepare_id: 'prepared-id'
  };
  payload.sign_string = clickSignature(payload, 'merchant-secret', true);
  assert.equal(verifyClickSignature(payload, 'merchant-secret', true), true);
  assert.equal(verifyClickSignature(payload, 'wrong-secret', true), false);
  assert.equal(verifyClickSignature(payload, 'merchant-secret', false), false);
});

test('Payme checkout encodes exact UZS-to-tiyin amount and payment reference', () => {
  const url = paymeCheckoutUrl('merchant-1', 'payment-uuid', 79000, 'https://app.example/return');
  const encoded = url.split('/').pop();
  const params = Buffer.from(encoded, 'base64url').toString('utf8');
  assert.equal(url.startsWith('https://checkout.paycom.uz/'), true);
  assert.match(params, /m=merchant-1/);
  assert.match(params, /ac\.payment_id=payment-uuid/);
  assert.match(params, /a=7900000/);
  assert.match(params, /c=https:\/\/app\.example\/return/);
});

test('Click checkout uses a server-created payment reference and the configured price', () => {
  const url = new URL(clickCheckoutUrl({
    serviceId: 'service-1',
    merchantId: 'merchant-1',
    amountUzs: 29000,
    paymentId: 'payment-uuid',
    returnUrl: 'https://app.example/return'
  }));
  assert.equal(url.origin + url.pathname, 'https://my.click.uz/services/pay');
  assert.equal(url.searchParams.get('amount'), '29000');
  assert.equal(url.searchParams.get('transaction_param'), 'payment-uuid');
});

test('FREE AI is capped at five daily requests while PRO has no daily quota', () => {
  assert.equal(aiUsageAllowed(false, 0), true);
  assert.equal(aiUsageAllowed(false, 4), true);
  assert.equal(aiUsageAllowed(false, 5), false);
  assert.equal(aiUsageAllowed(true, 5000), true);
});

test('PRO access requires an active, unexpired subscription', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  assert.equal(subscriptionIsActive({
    status: 'active',
    expires_at: '2026-11-05T12:00:00.000Z'
  }, now), true);
  assert.equal(subscriptionIsActive({
    status: 'active',
    expires_at: '2026-11-03T12:00:00.000Z'
  }, now), false);
  assert.equal(subscriptionIsActive({
    status: 'revoked',
    expires_at: '2026-12-03T12:00:00.000Z'
  }, now), false);
});

test('AI queue starts waiting PRO work before waiting FREE work', async () => {
  let releaseBlockers;
  let markBlockersStarted;
  let startedCount = 0;
  const blockerGate = new Promise(resolve => { releaseBlockers = resolve; });
  const blockersStarted = new Promise(resolve => { markBlockersStarted = resolve; });
  const blockers = Array.from({ length: 4 }, () => enqueueAiRequest(false, async () => {
    startedCount++;
    if (startedCount === 4) markBlockersStarted();
    await blockerGate;
  }));
  await blockersStarted;

  const order = [];
  const free = enqueueAiRequest(false, async () => { order.push('free'); });
  const pro = enqueueAiRequest(true, async () => { order.push('pro'); });
  releaseBlockers();
  await Promise.all([...blockers, free, pro]);
  assert.deepEqual(order, ['pro', 'free']);
});

test('manual payment receipt uploads require a real supported image signature', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const webp = Buffer.from('RIFF0000WEBP', 'ascii');
  assert.equal(receiptMimeMatches(jpeg, 'image/jpeg'), true);
  assert.equal(receiptMimeMatches(png, 'image/png'), true);
  assert.equal(receiptMimeMatches(webp, 'image/webp'), true);
  assert.equal(receiptMimeMatches(Buffer.from('not an image'), 'image/png'), false);
  assert.equal(receiptMimeMatches(png, 'image/jpeg'), false);
});

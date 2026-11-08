const crypto = require('node:crypto');

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!suppliedHash || !Number.isInteger(authDate)) return null;
  if (authDate > Math.floor(Date.now() / 1000) + 60 || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', botToken).update('WebAppData').digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqual(expectedHash, suppliedHash)) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    const telegramId = Number(user.id);
    return Number.isSafeInteger(telegramId) && telegramId > 0 ? user : null;
  } catch {
    return null;
  }
}

function clickSignature(payload, secret, complete = false) {
  const fields = [
    payload.click_trans_id,
    payload.service_id,
    secret,
    payload.merchant_trans_id,
    payload.amount,
    payload.action,
    payload.sign_time
  ];
  if (complete) fields.push(payload.click_prepare_id);
  return crypto.createHash('md5').update(fields.join('')).digest('hex');
}

function verifyClickSignature(payload, secret, complete = false) {
  return Boolean(secret && payload.sign_string &&
    safeEqual(clickSignature(payload, secret, complete).toLowerCase(), String(payload.sign_string).toLowerCase()));
}

function paymeCheckoutUrl(merchantId, paymentId, amountUzs, returnUrl) {
  const params = [
    'm=' + merchantId,
    'ac.payment_id=' + paymentId,
    'a=' + (Number(amountUzs) * 100),
    'c=' + returnUrl
  ].join(';');
  return 'https://checkout.paycom.uz/' + Buffer.from(params).toString('base64url');
}

function subscriptionIsActive(subscription, now = new Date()) {
  return Boolean(subscription && subscription.status === 'active' &&
    new Date(subscription.expires_at).getTime() > now.getTime());
}

function aiUsageAllowed(isPro, requestsUsedBeforeThisRequest, freeDailyLimit = 5) {
  return Boolean(isPro) || requestsUsedBeforeThisRequest < freeDailyLimit;
}

function clickCheckoutUrl({ serviceId, merchantId, amountUzs, paymentId, returnUrl }) {
  const params = new URLSearchParams({
    service_id: serviceId,
    merchant_id: merchantId,
    amount: String(amountUzs),
    transaction_param: paymentId,
    return_url: returnUrl
  });
  return 'https://my.click.uz/services/pay?' + params.toString();
}

module.exports = {
  clickCheckoutUrl,
  clickSignature,
  aiUsageAllowed,
  paymeCheckoutUrl,
  safeEqual,
  subscriptionIsActive,
  verifyClickSignature,
  verifyTelegramInitData
};

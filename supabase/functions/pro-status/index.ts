const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const encoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifiedTelegramUser(initData: string, botToken: string) {
  if (!initData || initData.length > 8192) return null;

  const params = new URLSearchParams(initData);
  const entries = Array.from(params.entries());
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;

  const suppliedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHash) || !Number.isInteger(authDate) ||
      authDate > now + 60 || now - authDate > 86400) {
    return null;
  }

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secretKey = await hmac(encoder.encode(botToken), "WebAppData");
  const expectedHash = toHex(await hmac(new Uint8Array(secretKey), dataCheckString));
  if (!safeEqual(expectedHash, suppliedHash)) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    const telegramId = Number(user.id);
    return Number.isSafeInteger(telegramId) && telegramId > 0
      ? { id: telegramId }
      : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!botToken || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "PRO status service is not configured." }, 503);
  }

  let body: { initData?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }
  if (!body || typeof body !== "object" || typeof body.initData !== "string") {
    return jsonResponse({ error: "Telegram initData is required." }, 400);
  }

  const telegramUser = await verifiedTelegramUser(body.initData, botToken);
  if (!telegramUser) {
    return jsonResponse({ error: "Telegram session could not be verified." }, 401);
  }

  const userUrl = new URL("/rest/v1/users", supabaseUrl);
  userUrl.searchParams.set("select", "is_pro,pro_status,pro_until,pro_expires,pro_expires_at");
  userUrl.searchParams.set("telegram_id", "eq." + telegramUser.id);
  userUrl.searchParams.set("limit", "1");
  const subscriptionUrl = new URL("/rest/v1/subscriptions", supabaseUrl);
  subscriptionUrl.searchParams.set("select", "status,expires_at,ends_at");
  subscriptionUrl.searchParams.set("user_telegram_id", "eq." + telegramUser.id);
  subscriptionUrl.searchParams.set("limit", "1");

  try {
    const headers = {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
    };
    const [userResponse, subscriptionResponse] = await Promise.all([
      fetch(userUrl, { headers }),
      fetch(subscriptionUrl, { headers }),
    ]);
    if (!userResponse.ok || !subscriptionResponse.ok) {
      return jsonResponse({ error: "PRO status could not be loaded." }, 503);
    }

    const [users, subscriptions] = await Promise.all([
      userResponse.json(),
      subscriptionResponse.json(),
    ]);
    const user = Array.isArray(users) ? users[0] : null;
    const subscription = Array.isArray(subscriptions) ? subscriptions[0] : null;
    const now = Date.now();
    const userExpiryValue = user && (user.pro_expires_at || user.pro_until || user.pro_expires);
    const userExpiry = userExpiryValue ? Date.parse(userExpiryValue) : NaN;
    const subscriptionExpiryValue = subscription && (subscription.expires_at || subscription.ends_at);
    const subscriptionExpiry = subscriptionExpiryValue
      ? Date.parse(subscriptionExpiryValue)
      : NaN;
    const subscriptionIsActive = Boolean(
      subscription &&
      subscription.status === "active" &&
      Number.isFinite(subscriptionExpiry) &&
      subscriptionExpiry > now
    );
    const userIsActive = Boolean(user && user.is_pro === true &&
      (!userExpiryValue || (Number.isFinite(userExpiry) && userExpiry > now)));
    const expired = Boolean(
      (user && Number.isFinite(userExpiry) && userExpiry <= now) ||
      (subscription && subscription.status === "active" &&
        Number.isFinite(subscriptionExpiry) && subscriptionExpiry <= now)
    );
    if (user && user.is_pro === true && !userIsActive) {
      const updateResponse = await fetch(userUrl, {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ is_pro: false, pro_status: "free" }),
      });
      if (!updateResponse.ok) {
        return jsonResponse({ error: "Expired PRO status could not be updated." }, 503);
      }
    }
    if (subscription && subscription.status === "active" && !subscriptionIsActive) {
      const updateResponse = await fetch(subscriptionUrl, {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ status: "expired" }),
      });
      if (!updateResponse.ok) {
        return jsonResponse({ error: "Expired subscription could not be updated." }, 503);
      }
    }
    return jsonResponse({
      isPro: userIsActive,
      status: userIsActive ? "active" : expired ? "expired" : "free",
      expired,
      proUntil: userExpiryValue || (subscriptionIsActive ? subscriptionExpiryValue : null) || null,
    });
  } catch {
    return jsonResponse({ error: "PRO status could not be loaded." }, 503);
  }
});

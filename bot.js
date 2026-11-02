// ==========================================
// 1. SOZLAMALAR (BU YERLARNI TO'LDIRING!)
// ==========================================
const TOKEN = "SIZNING_BOT_TOKENINGIZ"; 
const WEBAPP_URL = "https://jazzy-toffee-a454d0.netlify.app"; // Netlify havolangiz
const BACKEND_URL = "http://localhost:3000"; // Hozircha noutbukda, keyin Render havolasi

// Bot bazaga to'g'ridan-to'g'ri ulanishi uchun Supabase kalitlari
const SUPABASE_URL = "https://sizning_loyihangiz.supabase.co"; 
const SUPABASE_KEY = "sb_secret_sizning_kalitingiz"; 

// ==========================================
// 2. YORDAMCHI FUNKSIYA (Baza bilan ishlash)
// ==========================================
async function supabaseRequest(table, method, body, query = "") {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + table + query, {
    method: method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: body ? JSON.stringify(body) : null
  });
  return res;
}

// ==========================================
// 3. ASOSIY BOT KODI
// ==========================================
async function startBot() {
  console.log("🤖 Bot muvaffaqiyatli ishga tushdi...");
  let offset = 0;

  while (true) {
    try {
      const res = await fetch("https://api.telegram.org/bot" + TOKEN + "/getUpdates?offset=" + offset + "&timeout=30");
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          // A) FOYDALANUVCHI /START BUYRUG'INI YUBORGANDA
          if (update.message && update.message.text === '/start') {
            const chatId = update.message.chat.id;
            const firstName = update.message.from.first_name || "Foydalanuvchi";
            const username = update.message.from.username || "";
            
            let userStatusText = "";
            
            try {
              const authRes = await fetch(BACKEND_URL + "/api/auth", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegramId: chatId, firstName: firstName, username: username })
              });
              
              const userData = await authRes.json();
              
              if (userData.isPro) {
                userStatusText = "👑 Sizda <b>PRO</b> obuna faol!";
              } else if (userData.isTrialActive) {
                userStatusText = "🎁 Sizga <b>7 kunlik bepul</b> muddat berilgan. Qolgan kunlar: <b>" + userData.daysLeft + " kun</b>.";
              } else {
                userStatusText = "🚫 Bepul muddatingiz tugagan. Iltimos, ilovaga kirib <b>Pro obuna</b> sotib oling.";
              }
            } catch (e) {
              userStatusText = "⚠️ Server bilan aloqa yo'q. Iltimos, keyinroq urinib ko'ring.";
            }

            const text = "Assalomu alaykum, <b>" + firstName + "</b>! 👋\n\n💸 <b>Xarajat AI</b> — bu sizning shaxsiy moliyaviy yordamchingiz.\n\n" + userStatusText + "\n\nBoshlash uchun pastdagi tugmani bosing! 👇";

            await fetch("https://api.telegram.org/bot" + TOKEN + "/sendMessage", {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: "🚀 Ilovani ochish", web_app: { url: WEBAPP_URL } }]]
                }
              })
            });
          }

          // B) ADMIN TASDIQLASH YOKI RAD ETISH TUGMASINI BOSGANDA
          if (update.callback_query) {
            const cb = update.callback_query;
            const cbData = cb.data;
            const adminChatId = cb.message.chat.id;
            const messageId = cb.message.message_id;
            
            // callback_data ni ajratib olamiz (masalan: approve_12_5)
            const parts = cbData.split('_');
            const action = parts[0]; // approve yoki reject
            const requestId = parts[1];
            const targetUserId = parts[2];

            if (action === 'approve') {
              // 1. So'rovni tasdiqlash
              await supabaseRequest('pro_requests', 'PATCH', { status: 'approved' }, "?id=eq." + requestId);
              
              // 2. Foydalanuvchiga 30 kunlik Pro berish
              const expires = new Date();
              expires.setDate(expires.getDate() + 30);
              await supabaseRequest('users', 'PATCH', { is_pro: true, pro_expires: expires.toISOString() }, "?id=eq." + targetUserId);

              // 3. Adminning xabarini yangilash (tugmalarni olib tashlash)
              await fetch("https://api.telegram.org/bot" + TOKEN + "/editMessageCaption", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: adminChatId,
                  message_id: messageId,
                  caption: (cb.message.caption || "") + "\n\n✅ <b>TASDIQLANDI. 30 kunlik Pro berildi!</b>",
                  parse_mode: 'HTML'
                })
              });
            } 
            else if (action === 'reject') {
              // 1. So'rovni rad etish
              await supabaseRequest('pro_requests', 'PATCH', { status: 'rejected' }, "?id=eq." + requestId);

              // 2. Adminning xabarini yangilash
              await fetch("https://api.telegram.org/bot" + TOKEN + "/editMessageCaption", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: adminChatId,
                  message_id: messageId,
                  caption: (cb.message.caption || "") + "\n\n❌ <b>RAD ETILDI.</b>",
                  parse_mode: 'HTML'
                })
              });
            }

            // Telegramga "tugma bosildi" deb tasdiq yuborish (yuklanish belgisini o'chirish uchun)
            await fetch("https://api.telegram.org/bot" + TOKEN + "/answerCallbackQuery", {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id, text: action === 'approve' ? "Tasdiqlandi!" : "Rad etildi!" })
            });
          }
        }
      }
    } catch (error) {
      console.error("Xato:", error.message);
      await new Promise(r => setTimeout(r, 5000)); // Xato bo'lsa 5 soniya kutib qayta urinadi
    }
  }
}

startBot();

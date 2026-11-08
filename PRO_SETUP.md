# Xarajat AI PRO va moliyaviy platformani ishga tushirish

## 1. Maxfiy sozlamalar

`.env.example` dagi nom va namunaviy qiymatlarni hosting’ning environment/secret sozlamalariga kiriting. Haqiqiy `.env` faylini GitHub, Netlify yoki frontend hosting’ga hech qachon joylamang.

| O‘zgaruvchi | Majburiyligi | Kiritiladigan qiymat |
|---|---|---|
| `BOT_TOKEN` | Bot uchun majburiy | BotFather’dan olingan Telegram bot tokeni. Maxfiy saqlang. |
| `ADMIN_ID` | Admin buyruqlari uchun majburiy | Administratorning Telegram raqamli ID-si. Bir nechta admin bo‘lsa vergul bilan ajrating. |
| `SUPABASE_URL` | Backend uchun majburiy | Supabase loyihasining Project URL manzili. |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend uchun majburiy | Supabase server-side service role/secret kaliti. Frontendga yoki ommaviy repoga qo‘ymang. |
| `BOT_INTERNAL_SECRET` | Backend va bot uchun majburiy | Faqat bot backendga ishonchli so‘rov yuborishi uchun ishlatiladigan uzun, tasodifiy secret. |
| `WEBAPP_URL` | Bot uchun majburiy | Telegram menyusidagi Web App uchun ochiq HTTPS URL. |
| `BACKEND_URL` | Production bot uchun majburiy | API serverining ochiq HTTPS asosiy manzili. Faqat lokal ishlatishda kod `http://localhost:3000` ni standart qiladi. |
| `AI_API_KEY` | AI funksiyasi ishlatilsa kerak | Google Gemini API kaliti; serverda saqlanadi. |
| `AI_MODEL` | Ixtiyoriy | Gemini modeli; standart qiymati `gemini-3.8-flash`. |
| `PORT` | Ixtiyoriy | Server porti. Hosting port belgilamasa, standart qiymat `3000`. |
| `APP_ORIGIN` | Ixtiyoriy | Web App API’dan boshqa origin’da bo‘lsa uning origin’i; bir nechta origin vergul bilan ajratiladi. Bitta domenda ishlaganda kerak emas. |

Ilova `DATABASE_URL` emas, Supabase ulanishi uchun `SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY` dan foydalanadi. `AI_API_URL` hamda `AI_MODEL` berilmasa, backend standart AI endpoint/modelidan foydalanadi. Koddagi `TELEGRAM_BOT_TOKEN` va `ADMIN_TELEGRAM_IDS` eski sozlamalar bilan moslik uchun alias sifatida vaqtincha qo‘llanadi; yangi sozlamalarda `BOT_TOKEN` va `ADMIN_ID` nomlarini ishlating.

`AI_API_URL` ishlatilmaydi; AI so‘rovlari Google’ning rasmiy Gemini `generateContent` endpointiga yuboriladi.

Botni `npm run bot` bilan backend serverdan alohida jarayon sifatida ishga tushiring. Bot, backend va Web App bir-biriga ochiq tarmoq orqali ulana olishi kerak.

## 2. Supabase ma’lumotlar bazasi

Supabase SQL Editor’da [supabase-pro.sql](./supabase-pro.sql) faylini bajaring. U mavjud foydalanuvchilar va operatsiyalarni o‘chirmaydi; tariflar, obunalar, to‘lovlar, app sozlamalari, serverda saqlanadigan tranzaksiyalar, chek uchun maxfiy Storage bucket va atomar obuna RPC funksiyalarini yaratadi. Eski default PRO narxlari (29 000 / 79 000 / 249 000 UZS) yangi narxlarga bir marta o‘tkaziladi; administrator avvaldan o‘zgartirgan narxlar saqlanadi. Serverga service-role key kerak; jadvallar va chek Storage mijoz rollaridan berkitilgan.

Web App Telegram ichida ochilganda `X-Telegram-Init-Data` imzosi serverda tekshiriladi. Operatsiyalar faqat tekshirilgan Telegram foydalanuvchisi hisobidan o‘qiladi va yoziladi. Foydalanuvchi ID-si bilan bog‘lanmagan eski `localStorage` yozuvlari boshqa hisobga adashib biriktirilmasligi uchun avtomatik import qilinmaydi; ular brauzerning `xarajatlar` kalitida saqlanadi.

## 3. Frontend manzili

Tavsiya etilgan sozlama — Web App va API’ni bitta HTTPS domenda ishlatish: `WEBAPP_URL` ni backend domeni (`https://YOUR_BACKEND_HOST/`) qilib, botni qayta ishga tushiring. Backend `/` da faqat Web App `index.html` faylini beradi, `/api/*` marshrutlari esa shu origin’da ishlaydi; frontend bo‘sh `api-base-url` qiymatida avtomatik shu origin’dan foydalanadi.

Web App statik hostingda backenddan boshqa domenda bo‘lsa, `index.html` dagi `api-base-url` meta tegiga backendning `https://...` asosiy manzilini yozib, qayta deploy qiling. Backenddagi `APP_ORIGIN` ga Web App domenini kiriting. Production muhitida `BACKEND_URL`, `WEBAPP_URL`, `APP_ORIGIN` uchun `localhost` ishlatmang. `GET /health` DB sozlamalari va ulanishini, `users`, `transactions`, obuna jadvallarini tekshiradi; sozlama yetishmasa HTTP 503 qaytaradi.

Telegram Web App uchun `WEBAPP_URL` HTTPS bo‘lishi kerak. Backend `/api/auth` da Telegram imzosini tekshiradi; foydalanuvchi Telegram Web App’dan tashqarida bo‘lsa, to‘lovni boshlay olmaydi.

## 4. PRO narxlari va qo‘lda to‘lov

Standart PRO narxlari: 1 oy — **14 990 UZS**, 3 oy — **44 990 UZS**, 12 oy — **179 990 UZS**. Administrator tarif narxi va muddatini boshqaruv panelidan o‘zgartirishi mumkin.

PRO xaridi qo‘lda tekshiriladi:

1. Foydalanuvchi tarifni tanlaydi va server `pending` to‘lov yozuvini yaratadi.
2. Administrator kiritgan bank/karta rekvizitlari ko‘rsatiladi.
3. Foydalanuvchi tranzaksiya raqami va chek rasmini yuboradi. Rasm maxfiy Supabase Storage’da saqlanadi.
4. Admin panelida administrator chekni tekshiradi va tasdiqlaydi yoki rad etadi.
5. Faqat administrator tasdig‘idagi atomar DB funksiyasi to‘lovni `paid` qiladi va PRO muddatini beradi. Takroriy tasdiq obuna muddatini qayta qo‘shmaydi.

Chek rasmi hech qachon avtomatik ravishda obuna bermaydi. Admin panelida to‘lov rekvizitlari, tariflar, chek tekshiruvi, foydalanuvchi PRO holati, tushum, xabar tarqatish va AI yo‘riqnomasi boshqariladi. `app_settings` jadvali migratsiyada yaratiladi.

## 5. To‘lov

To‘lov faqat qo‘lda tekshiriladi. Foydalanuvchi tarifni tanlaydi, administrator sozlagan rekvizitga to‘laydi va chekni yuboradi. Administrator chekni ko‘rib tasdiqlagandan keyingina PRO faollashadi. Bu oqim uchun Click/Payme merchant ID, service ID, secret key yoki callback URL environment sozlamalari kerak emas.

Chek yuborish uchun migratsiya Supabase’ning `manual-payment-receipts` maxfiy Storage bucketini yaratadi. Migratsiyadan keyin Supabase loyihangizda bucket maxfiy ekanini va 5 MB gacha rasm yuklashni qo‘llashini tekshiring.

## 6. Tekshiruv

- `npm test` — Telegram initData imzosi, Click callback, checkout helper’lari, FREE/PRO AI kvotasi va navbat testlari.
- Supabase SQL migratsiyasini avval test loyihasida bajaring; qo‘lda chek yuklash/tasdiqlash va operatsiyalarni serverga sinxronlashni sinab ko‘ring.
- Backend `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOT_TOKEN` yoki `BOT_INTERNAL_SECRET` sozlanmagan bo‘lsa ishga tushmaydi.

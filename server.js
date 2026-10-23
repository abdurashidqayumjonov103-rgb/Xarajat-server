const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// BU YERGA O'ZINGIZNING SUPABASE KALITLARINGIZNI QO'YING:
const SUPABASE_URL = "https://mthvyudkbfbwbjnjwlfa.supabase.co";
const SUPABASE_KEY = "sb_secret_yoWWppjmqXIuLaJENMS4BQ_Wi-X9cHo";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. Foydalanuvchini tekshirish va yaratish
app.post('/api/auth', async (req, res) => {
  const { telegramId, firstName, username } = req.body;
  if (!telegramId) return res.status(400).json({ error: "ID kerak" });

  // Bazadan qidirish
  let { data: user, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();

  // Agar yo'q bo'lsa, yaratish
  if (!user) {
    const { data: newUser, error: insertError } = await supabase.from('users').insert([
      { telegram_id: telegramId, first_name: firstName, username: username }
    ]).select().single();
    if (insertError) return res.status(500).json({ error: insertError.message });
    user = newUser;
  }

  res.json(user);
});

// 2. Operatsiyalarni olish
app.get('/api/transactions/:userId', async (req, res) => {
  const userId = req.params.userId;
  const { data, error } = await supabase.from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
    
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 3. Yangi operatsiya qo'shish
app.post('/api/transactions', async (req, res) => {
  const { userId, type, amount, category, note } = req.body;
  const { data, error } = await supabase.from('transactions').insert([
    { user_id: userId, type, amount, category, note }
  ]).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Serverni ishga tushirish
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlayapti...`);
});

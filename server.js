const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==========================================
// BU YERGA O'ZINGIZNING SUPABASE MA'LUMOTLARINI QO'YING:
// ==========================================
const SUPABASE_URL = "https://mthvyudkbfbwbjnjwlfa.supabase.co"; // Project URL
const SUPABASE_KEY = "sb_secret_EUSVmyhcUFfxoIa0tiLSRQ_gHUEevVj"; // Secret Key (sb_secret_ bilan boshlanadi)

// Supabase'ga ulanish (Yangi API kalitlar uchun maxsus sarlavha bilan)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'User-Agent': 'XarajatAI-Server/1.0' } }
});

// 1. Foydalanuvchini tekshirish va yaratish
app.post('/api/auth', async (req, res) => {
  const { telegramId, firstName, username } = req.body;
  if (!telegramId) return res.status(400).json({ error: "Telegram ID kerak" });

  try {
    // Bazadan qidirish
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (error) throw error;

    // Agar yo'q bo'lsa, yaratish
    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([{ telegram_id: telegramId, first_name: firstName, username: username }])
        .select()
        .single();
        
      if (insertError) throw insertError;
      user = newUser;
    }

    res.json(user);
  } catch (err) {
    console.error("Auth xatosi:", err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Operatsiyalarni olish
app.get('/api/transactions/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });
      
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Yangi operatsiya qo'shish
app.post('/api/transactions', async (req, res) => {
  const { userId, type, amount, category, note } = req.body;
  try {
    const { data, error } = await supabase
      .from('transactions')
      .insert([{ user_id: userId, type, amount, category, note }])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Operatsiyani o'chirish
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', req.params.id);
      
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serverni ishga tushirish
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlayapti...`);
});

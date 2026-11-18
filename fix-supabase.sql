-- Ushbu kodni Supabase Dashboard -> SQL Editor bo'limida ishga tushiring (Run qiling).
-- U mavjud ma'lumotlarni saqlab qolgan holda jadvallarni yangilaydi.

-- 1. payments jadvaliga yangi ustunlarni qo'shish
alter table public.payments add column if not exists user_telegram_id bigint;
alter table public.payments add column if not exists plan_id text;
alter table public.payments add column if not exists amount_uzs bigint;
alter table public.payments add column if not exists duration_months integer default 1;
alter table public.payments add column if not exists provider text default 'manual';
alter table public.payments add column if not exists provider_data jsonb default '{}'::jsonb;
alter table public.payments add column if not exists expires_at timestamptz default (now() + interval '72 hours');
alter table public.payments add column if not exists paid_at timestamptz;

-- Eski ustunlar bo'lsa, ma'lumotlarni ko'chirish
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'telegram_id') then
    update public.payments set user_telegram_id = coalesce(user_telegram_id, telegram_id) where user_telegram_id is null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'plan') then
    update public.payments set plan_id = coalesce(plan_id, plan) where plan_id is null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'amount') then
    update public.payments set amount_uzs = coalesce(amount_uzs, amount) where amount_uzs is null;
  end if;
end $$;

-- 2. subscription_plans jadvali
create table if not exists public.subscription_plans (
  id text primary key,
  name text not null,
  duration_months integer not null check (duration_months between 1 and 36),
  price_uzs bigint not null check (price_uzs > 0),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.subscription_plans (id, name, duration_months, price_uzs)
values
  ('1-month', '1 Oylik PRO', 1, 14990),
  ('3-month', '3 Oylik PRO', 3, 44990),
  ('6-month', '6 Oylik PRO', 6, 89990),
  ('12-month', '1 Yillik PRO', 12, 179990)
on conflict (id) do update
set price_uzs = excluded.price_uzs,
    name = excluded.name,
    duration_months = excluded.duration_months;

-- 3. app_settings jadvali
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values
  ('manual_payment_details', '{"account":"9860 **** **** 0000","accountName":"XARAJAT AI","bank":"Ipoteka Bank","instructions":"To‘lovni amalga oshirgach, chekni botga yuboring"}'),
  ('notifications_enabled', 'true')
on conflict (key) do nothing;

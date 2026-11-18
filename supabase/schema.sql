create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  description text
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  req_id text not null unique,
  request_day date not null,
  request_date_text text not null,
  request_time_text text not null,
  timestamp_ms bigint not null,
  first_name text not null,
  last_name text not null,
  full_name text not null,
  agency text not null,
  citizen_id text not null,
  masked_citizen_id text not null,
  status text not null,
  recorder text not null default 'เจ้าหน้าที่',
  note text not null default '-',
  telegram_status text not null default 'Pending',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop index if exists public.requests_unique_person_per_day;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists requests_set_updated_at on public.requests;

create trigger requests_set_updated_at
before update on public.requests
for each row
execute procedure public.set_updated_at();

insert into public.app_settings (key, value, description) values
  ('APP_TITLE', 'ระบบนัดหมายออนไลน์', 'ชื่อระบบนัดหมายออนไลน์'),
  ('TELEGRAM_BOT_TOKEN', '', 'Token จาก BotFather'),
  ('TELEGRAM_CHAT_ID', '', 'Chat ID สำรองเมื่อยังไม่ได้กำหนดห้องของกลุ่มงาน'),
  ('TELEGRAM_BOOKING_CONFIRM_TEXT', '✅ ยืนยันนัดหมาย', 'ข้อความปุ่ม Telegram: ยืนยันนัดหมาย'),
  ('TELEGRAM_BOOKING_CANCEL_TEXT', '❌ ยกเลิกคิว', 'ข้อความปุ่ม Telegram: ยกเลิกคิว'),
  ('TELEGRAM_BOOKING_CANCEL_REASON_TEXT', '✍️ ระบุเหตุผล', 'ข้อความปุ่ม Telegram: ระบุเหตุผลการยกเลิก'),
  ('TELEGRAM_BOOKING_CANCEL_SKIP_TEXT', 'ยกเลิกโดยไม่ระบุเหตุผล', 'ข้อความปุ่ม Telegram: ยกเลิกโดยไม่ระบุเหตุผล')
on conflict (key) do update set description = excluded.description;

update public.app_settings
set value = 'ระบบนัดหมายออนไลน์', description = 'ชื่อระบบนัดหมายออนไลน์'
where key = 'APP_TITLE' and value = 'ระบบบำเหน็จค้ำประกัน';

-- Optional Telegram destinations for appointment notifications, by responsible department.
insert into public.app_settings (key, value, description) values
  ('TELEGRAM_CHAT_ID_BOOKING_ADMIN', '', 'Telegram chat ID for ฝ่ายบริหารทั่วไป bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_ACADEMIC', '', 'Telegram chat ID for กลุ่มงานวิชาการ bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_GF', '', 'Telegram chat ID for กลุ่มงานระบบการคลัง GF bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_POLICY', '', 'Telegram chat ID for กลุ่มงานนโยบายและเศรษฐกิจการคลัง bookings')
on conflict (key) do update set description = excluded.description;

delete from public.app_settings
where key in ('ENABLE_DASHBOARD', 'SEND_FULL_ID')
  or key like 'TG_BTN_%';

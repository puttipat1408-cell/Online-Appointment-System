create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  description text
);

insert into public.app_settings (key, value, description) values
  ('TELEGRAM_CHAT_ID_BOOKING_ADMIN', '', 'Telegram chat ID for ฝ่ายบริหารทั่วไป bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_ACADEMIC', '', 'Telegram chat ID for กลุ่มงานวิชาการ bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_GF', '', 'Telegram chat ID for กลุ่มงานระบบการคลัง GF bookings'),
  ('TELEGRAM_CHAT_ID_BOOKING_POLICY', '', 'Telegram chat ID for กลุ่มงานนโยบายและเศรษฐกิจการคลัง bookings'),
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

delete from public.app_settings
where key in ('ENABLE_DASHBOARD', 'SEND_FULL_ID')
  or key like 'TG_BTN_%';

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  ticket_id text not null unique,
  amount integer not null default 1 check (amount = 1),
  appointment_date date not null,
  time_slot text not null,
  agency text not null,
  topic text not null,
  department text not null,
  consultation_details text not null default '',
  receiver_name text not null default '',
  note text not null default '',
  status text not null default 'รอตอบรับ',
  pending_cancel_user_id bigint,
  pending_cancel_chat_id bigint,
  pending_cancel_message_id bigint,
  pending_cancel_at timestamptz,
  satisfaction_rating smallint check (satisfaction_rating between 1 and 5),
  satisfaction_feedback text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.bookings add column if not exists note text not null default '';
alter table public.bookings add column if not exists consultation_details text not null default '';
alter table public.bookings add column if not exists pending_cancel_user_id bigint;
alter table public.bookings add column if not exists pending_cancel_chat_id bigint;
alter table public.bookings add column if not exists pending_cancel_message_id bigint;
alter table public.bookings add column if not exists pending_cancel_at timestamptz;
alter table public.bookings
  add column if not exists satisfaction_rating smallint check (satisfaction_rating between 1 and 5);
alter table public.bookings
  add column if not exists satisfaction_feedback text not null default '';

create unique index if not exists bookings_unique_active_slot
  on public.bookings (appointment_date, department, time_slot)
  where status <> 'ยกเลิก';

create or replace function public.set_booking_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists bookings_set_updated_at on public.bookings;

create trigger bookings_set_updated_at
before update on public.bookings
for each row
execute procedure public.set_booking_updated_at();

create or replace function public.get_booking_rating_stats(p_topic text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'total', count(satisfaction_rating),
    'average', coalesce(round(avg(satisfaction_rating::numeric), 2), 0),
    'counts', jsonb_build_object(
      '1', count(*) filter (where satisfaction_rating = 1),
      '2', count(*) filter (where satisfaction_rating = 2),
      '3', count(*) filter (where satisfaction_rating = 3),
      '4', count(*) filter (where satisfaction_rating = 4),
      '5', count(*) filter (where satisfaction_rating = 5)
    )
  )
  from public.bookings
  where topic = p_topic and satisfaction_rating is not null;
$$;

revoke all on function public.get_booking_rating_stats(text) from public, anon, authenticated;
grant execute on function public.get_booking_rating_stats(text) to service_role;

# ระบบจองคิวนัดหมายออนไลน์

แอป Next.js สำหรับจองคิวและติดตามสถานะ ใช้ Supabase เก็บข้อมูล และส่งแจ้งเตือนผ่าน Telegram Bot โดยเลือกห้องแชตตามกลุ่มงานที่รับผิดชอบ

## เริ่มใช้งานในเครื่อง

1. ติดตั้ง dependencies:

```bash
pnpm install
```

2. คัดลอกไฟล์ตัวอย่าง environment:

```powershell
Copy-Item .env.example .env.local
```

กรอกค่า Supabase ฝั่ง server ให้ครบ (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) ห้ามนำ `.env.local` ขึ้น Git
3. เปิด Supabase SQL Editor แล้วรัน `supabase/booking-system.sql` เพื่อสร้างตารางจองคิวและการตั้งค่า Telegram
4. ตั้งค่า Telegram ตามหัวข้อด้านล่าง
5. เริ่มเว็บในโหมดพัฒนา:

```bash
pnpm dev
```

จากนั้นเปิด `http://localhost:3000`.

การรัน `supabase/booking-system.sql` กับฐานข้อมูลเดิมจะลบคีย์ตั้งค่าเก่าของ D-pension เพิ่มคีย์ข้อความปุ่มของระบบนัดหมาย และคงค่า Telegram token กับ Chat ID ที่ตั้งไว้แล้ว

## Telegram: ตั้งค่าบอทและกลุ่มแชต

ระบบใช้ Telegram Bot เดิมที่บันทึกใน Supabase ตาราง `app_settings`:

- `APP_TITLE`: ชื่อระบบ (ระบบนัดหมายออนไลน์)
- `TELEGRAM_BOT_TOKEN`: token จาก BotFather
- `TELEGRAM_CHAT_ID_BOOKING_ADMIN`: ฝ่ายบริหารทั่วไป
- `TELEGRAM_CHAT_ID_BOOKING_ACADEMIC`: กลุ่มงานวิชาการ
- `TELEGRAM_CHAT_ID_BOOKING_GF`: กลุ่มงานระบบการคลัง GF
- `TELEGRAM_CHAT_ID_BOOKING_POLICY`: กลุ่มนโยบายเศรษฐกิจการคลัง
- `TELEGRAM_CHAT_ID`: ห้องสำรองเมื่อยังไม่ได้กำหนดห้องของกลุ่มงานนั้น
- `TELEGRAM_BOOKING_CONFIRM_TEXT`: ข้อความปุ่มยืนยันนัดหมาย
- `TELEGRAM_BOOKING_CANCEL_TEXT`: ข้อความปุ่มยกเลิกคิว
- `TELEGRAM_BOOKING_CANCEL_REASON_TEXT`: ข้อความปุ่มระบุเหตุผลการยกเลิก
- `TELEGRAM_BOOKING_CANCEL_SKIP_TEXT`: ข้อความปุ่มยกเลิกโดยไม่ระบุเหตุผล

เพิ่มบอทเข้าแต่ละกลุ่ม แล้วกำหนดค่า Chat ID ใน Supabase SQL Editor ตัวอย่าง (แทนค่าตัวอย่างด้วยค่าจริง):

```sql
update public.app_settings
set value = 'ใส่_CHAT_ID_ของกลุ่ม'
where key = 'TELEGRAM_CHAT_ID_BOOKING_ACADEMIC';
```

ทำซ้ำกับ key ของแต่ละกลุ่มที่ต้องการใช้ ค่า token และ Chat ID เป็นความลับ อย่าใส่ไว้ในโค้ดหน้าเว็บหรือ commit ลง Git

เมื่อมีการจองใหม่ บอทจะส่งรายละเอียดไปยังกลุ่มที่ตรงกับกลุ่มงาน พร้อมปุ่ม **ยืนยันนัดหมาย** และ **ยกเลิกคิว** การกดปุ่มจะปรับสถานะรายการจองใน Supabase โดย webhook ต้องตั้งค่าไว้ที่เว็บ production จึงจะรับการกดปุ่มได้

## แบบประเมินความพึงพอใจ

ผู้จองเปิดหน้าติดตามสถานะด้วย Ticket ID หรือ QR Code แล้วให้คะแนนเรื่องที่จองได้ตั้งแต่ 1–5 ดาว ระบบบันทึกคะแนนแยกตามเรื่อง พร้อมแสดงคะแนนเฉลี่ยและจำนวนคะแนน สามารถปรับคะแนนของคิวเดิมได้ แต่คิวที่ยกเลิกแล้วให้คะแนนไม่ได้

หลังอัปเดตโค้ด ให้รัน `supabase/booking-system.sql` ซ้ำใน Supabase SQL Editor เพื่อเพิ่มคอลัมน์คะแนนและฟังก์ชันสรุปผล (คำสั่งรองรับการรันซ้ำ)

## Telegram Webhook

Webhook ใช้รับ callback จากปุ่มใน Telegram และต้องชี้ไปยัง URL สาธารณะที่เป็น HTTPS เช่น `https://your-domain.vercel.app/api/telegram/webhook` ห้ามใช้ `localhost` เป็นปลายทาง webhook จริง

ตั้งค่า `NEXT_PUBLIC_APP_URL` ใน `.env.local` ให้เป็น URL เว็บที่ deploy แล้ว จากนั้นรัน:

```bash
pnpm telegram:webhook:info
pnpm telegram:webhook:set
```

- `info` แสดงสถานะ webhook ปัจจุบันของบอท
- `set` กำหนด webhook ไปยัง `NEXT_PUBLIC_APP_URL/api/telegram/webhook`
- หากต้องการใช้ URL อื่นชั่วคราว กำหนด `TELEGRAM_WEBHOOK_URL` ใน `.env.local` ก่อนสั่ง `set`

สคริปต์อ่าน `TELEGRAM_BOT_TOKEN` จาก `app_settings` และอ่าน URL/ข้อมูลเชื่อมต่อ Supabase จาก `.env.local` ดังนั้นต้องมี `SUPABASE_SERVICE_ROLE_KEY` ในเครื่องที่ใช้สั่ง webhook ด้วย

## Google Sheets รายงานการจอง

ระบบซิงก์ Google Sheets ผ่าน Apps Script Web App โดยไม่ต้องใช้ Google Cloud Service Account เมื่อมีการจองใหม่ ระบบเพิ่มข้อมูล และเมื่อเจ้าหน้าที่เปลี่ยนสถานะ ระบบอัปเดตแถวเดิมโดยจับคู่จาก Ticket ID

1. เปิด Google Sheet แล้วเลือก **ส่วนขยาย > Apps Script**
2. วางโค้ดจาก `google-apps-script/Code.gs` แล้วบันทึก
3. ใน Apps Script เปิด **การตั้งค่าโปรเจ็กต์ > Script Properties** และเพิ่ม `GOOGLE_SHEETS_WEBHOOK_SECRET` โดยใช้ค่าเดียวกับใน `.env.local`; โค้ดระบุแท็บรายงานจาก `gid` ในลิงก์ชีตไว้แล้ว
4. เลือก **ทำให้ใช้งานได้ > การทำให้ใช้งานได้รายการใหม่ > เว็บแอป** ตั้งให้ทำงานในนามบัญชีเจ้าของสคริปต์ และกำหนดผู้ที่เข้าถึงเป็นทุกคน จากนั้นอนุญาตสิทธิ์และคัดลอก URL ที่ลงท้าย `/exec`
5. ใส่ URL นั้นใน `GOOGLE_APPS_SCRIPT_URL` และใส่ secret เดียวกันใน `GOOGLE_SHEETS_WEBHOOK_SECRET` ทั้ง `.env.local` และ Vercel (ใน Project Settings > Environment Variables) แล้วสั่ง Redeploy บน Vercel
6. หากต้องการซิงค์ข้อมูลการจองย้อนหลังทั้งหมดที่มีใน Supabase เข้า Google Sheet ให้สั่ง:

```bash
pnpm sheets:sync
```

Secret ใช้ป้องกันไม่ให้บุคคลอื่นส่งข้อมูลเข้า endpoint อย่าใส่ในหน้าเว็บ อย่าส่งในแชต และอย่า commit ลง Git ระบบใช้ชีต `1kpweyi5BoNQXBAUkC-YYR4Bpui7MB5jIkkVlm-izBE0` โดยจะเปลี่ยนชื่อแท็บเดิมเป็น `รายการจองรายวัน` สำหรับบันทึกคิวทุกวัน และจะคำนวณสร้างแท็บสรุปแยกตามแต่ละเดือนให้อัตโนมัติ เช่น `สรุป พ.ย. 2569` (มีทั้งตารางสรุปแยกตามกลุ่มงาน และตารางสรุปรายวันในเดือน)

## คำสั่ง Git ที่ใช้บ่อย

ตรวจ branch, remote และสถานะไฟล์ก่อนเริ่ม:

```bash
git branch --show-current
git remote -v
git status
```

### เปลี่ยนชื่อผู้เขียน commit

ตั้งค่าเฉพาะ repository นี้ (แนะนำเมื่อใช้หลายบัญชี):

```bash
git config user.name "puttipat1408-cell
git config user.email "puttipat1408@gmail.com"
git config --get user.name
git config --get user.email
git config --global user.name "puttipat1408-cell"
git config --global user.email "puttipat1408@gmail.com"
```

ค่า `user.name` และ `user.email` ใช้ระบุผู้เขียน commit และมีผลกับ commit ใหม่เท่านั้น ไม่ได้เปลี่ยนบัญชีที่ใช้ยืนยันตัวตนตอน push หากต้องการตั้งเป็นค่าเริ่มต้นให้ทุก repository ให้เพิ่ม `--global` ในคำสั่ง `git config`

### เปลี่ยน repository ปลายทาง (remote)

ตั้ง remote ครั้งแรก (ถ้ายังไม่มี `origin`):

```bash
git remote add origin https://github.com/maxza3001/Online-Appointment-System.git
```

หากมี `origin` อยู่แล้วและต้องการเปลี่ยน URL:

```bash
git remote set-url origin https://github.com/maxza3001/Online-Appointment-System.git
git remote -v
```

ชื่อเจ้าของ repository ใน URL กำหนดว่าจะ push ไป repository ไหน ส่วนบัญชี GitHub ที่ใช้ push มาจากข้อมูลยืนยันตัวตนที่บันทึกไว้ในเครื่อง และต้องมีสิทธิ์เขียนใน repository นั้น

บน Windows หาก Git ยังใช้บัญชีเดิม ให้เปิด **Control Panel > Credential Manager > Windows Credentials** แล้วลบรายการ GitHub เก่า จากนั้นสั่ง `git push` อีกครั้งและลงชื่อเข้าใช้ด้วยบัญชีที่ต้องการเมื่อระบบถาม

บันทึกและส่งงานขึ้น GitHub:

```bash
git add .
git status
git diff --cached
git commit -m "เพิ่มชีต"
git push
```

หากเป็นการ push branch นี้ครั้งแรก:

```bash
git push -u origin HEAD
```

ก่อน commit ให้ตรวจ `git status` และ `git diff --cached` ทุกครั้ง อย่าใช้ `git add -f` กับ `.env.local` หรือไฟล์ที่มี secret; ไฟล์ environment จริงถูกกันไว้ใน `.gitignore` แล้ว

## คำสั่งพัฒนาเพิ่มเติม

```bash
pnpm build
pnpm start
pnpm lint
```

- `pnpm build` สร้าง production build
- `pnpm start` เปิด production build ที่สร้างแล้ว
- `pnpm lint` ตรวจรูปแบบและข้อผิดพลาดจาก ESLint

Push ไปยัง branch ที่เชื่อมกับ Vercel แล้ว Vercel จะ deploy ตามการตั้งค่าโปรเจกต์
#   O n l i n e - A p p o i n t m e n t - S y s t e m  
 
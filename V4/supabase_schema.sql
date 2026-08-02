-- ═══════════════════════════════════════════════════════════════
--  IDEA CarHub 360 — Supabase Schema
--  شغّل الملف ده مرة واحدة في: Supabase Dashboard > SQL Editor > Run
-- ═══════════════════════════════════════════════════════════════

-- الجدول الرئيسي: بيشيل كل تابات النظام (ClientData, Licenses,
-- CarSpecsCatalog, AISettings, AdminNumbers, WhatsAppMessages...)
-- بنفس منطق الشيت: tab = اسم التاب، row_num = رقم الصف، data = الأعمدة JSON
create table if not exists public.sheet_rows (
  tab        text        not null,
  row_num    integer     not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tab, row_num)
);

create index if not exists sheet_rows_tab_idx on public.sheet_rows (tab);

-- تأمين: نقفل الجدول تماماً على الـ anon/public — السيرفر بس (service_role)
-- هو اللي بيتعامل معاه، والـ service key بيتخطى RLS تلقائياً.
alter table public.sheet_rows enable row level security;
-- (مفيش policies متضافة عمداً = ولا حد غير service_role يقدر يوصل)

-- ═══════════════════════════════════════════════════════════════
--  فيديوهات الديمو (Supabase Storage)
--  الـ bucket بيتعمل تلقائياً أول مرة الأدمن يرفع فيديو (الكود بيعمل ده
--  لوحده عن طريق /storage/v1/bucket) — مش محتاج تعمل حاجة يدوي هنا.
--  الجدول اللي بيربط كل فيديو بمكانه (Target) هو تاب "DemoVideos"
--  جوه نفس جدول sheet_rows فوق — بيتعمل تلقائياً برضه.
--
--  الحاجة الوحيدة اليدوية (مرة واحدة): في Supabase Dashboard
--  Storage > Policies > للـ bucket "demo-videos" اعمل policy تسمح
--  بالقراءة العامة (SELECT) لو الـ bucket ما اتعملش public تلقائياً:
--
--  create policy "Public read demo videos"
--  on storage.objects for select
--  using (bucket_id = 'demo-videos');
-- ═══════════════════════════════════════════════════════════════

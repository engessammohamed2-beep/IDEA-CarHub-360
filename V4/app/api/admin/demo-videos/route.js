import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, appendRow, deleteRow, updateRow, ensureDemoVideosTab } from "@/lib/googleSheets";

export const runtime = "nodejs";

// أماكن الربط المتاحة: صفحات التطبيق + كل أنواع الصيانة (الأساسية + أي حقول Admin يضيفها)
const MAINT_TYPES = [
  ["oil", "🛢️ زيت الموتور"], ["oil-filter", "🔩 فلتر الزيت"], ["air-filter", "💨 فلتر الهوا"],
  ["fuel-filter", "⚗️ فلتر البنزين"], ["spark", "⚡ البوجيهات"], ["timing", "⚙️ سير الكاتينة"],
  ["coolant", "❄️ مية التبريد"], ["brake-pad", "🛑 تيل الفرامل"], ["brake-fluid", "🩸 سائل الفرامل"],
  ["tires", "🛞 الكاوتش"], ["belt", "➰ السير"], ["gearbox", "⚙️ زيت الفتيس"],
  ["power", "🔧 زيت الباور"], ["ac-filter", "🌬️ فلتر التكييف"],
];
const PAGE_TARGETS = [
  ["screen-home", "🏠 الرئيسية"], ["screen-car", "🚗 بيانات السيارة"],
  ["screen-maintenance", "🔧 الصيانات (عام)"], ["screen-fuel", "⛽ الوقود"],
  ["screen-violations", "🚨 المخالفات"], ["screen-licenses", "🪪 التراخيص والمرور"],
  ["screen-contacts", "🆘 SOS"], ["screen-trip", "🗺️ حاسبة السفر"],
  ["screen-reports", "📊 التقارير"], ["dealer-schedule", "🏢 صيانات التوكيل"],
];

// بيطلّع الآي دي بتاع فيديو يوتيوب من أي صيغة رابط شائعة (watch?v=, youtu.be/, shorts/)
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const admin = await requireAdminSession();
  const TAB = await ensureDemoVideosTab().catch(() => "DemoVideos");
  const rows = await readSheet(TAB).catch(() => []);
  const list = rows
    .filter((r) => r.YouTubeId)
    .map((r) => ({
      id: r.Id, youtubeId: r.YouTubeId, target: r.Target,
      targetLabel: r.TargetLabel, title: r.Title || "", createdAt: r.CreatedAt, _row: r._row,
    }));
  const headers = { "Cache-Control": "no-cache, no-store, must-revalidate" };
  if (!admin) {
    return NextResponse.json({
      videos: list.map(({ _row, ...rest }) => rest),
      targets: { maintTypes: MAINT_TYPES, pages: PAGE_TARGETS },
    }, { headers });
  }
  return NextResponse.json({ videos: list, targets: { maintTypes: MAINT_TYPES, pages: PAGE_TARGETS } }, { headers });
}

// POST { youtubeUrl, target, targetLabel, title } — الأدمن بيرفع الفيديو على
// يوتيوب كـ"غير مُدرَج" (Unlisted) بنفسه، ويلزق اللينك هنا. مفيش حد أقصى
// للحجم، ومفيش أي اعتماد على تخزين ملفات خارجي ممكن يفشل (زي ما حصل مع
// Supabase Storage) — يوتيوب بيستضيف الفيديو والتطبيق بس بيعرضه (embed).
export async function POST(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });

  let body = {};
  try { body = await req.json(); } catch {}
  const youtubeUrl = (body.youtubeUrl || "").toString().trim();
  const target = (body.target || "").toString().trim();
  const targetLabel = (body.targetLabel || "").toString().trim();
  const title = (body.title || "").toString().trim();

  if (!youtubeUrl) return NextResponse.json({ error: "رابط الفيديو مطلوب" }, { status: 400 });
  if (!target) return NextResponse.json({ error: "لازم تختار الصفحة أو نوع الصيانة اللي الفيديو مربوط بيها" }, { status: 400 });

  const youtubeId = extractYouTubeId(youtubeUrl);
  if (!youtubeId) {
    return NextResponse.json(
      { error: "رابط يوتيوب غير صالح. تأكد إنه بالصيغة: https://youtu.be/XXXXXXXXXXX أو https://www.youtube.com/watch?v=XXXXXXXXXXX" },
      { status: 400 }
    );
  }

  try {
    const TAB = await ensureDemoVideosTab();
    const rows = await readSheet(TAB).catch(() => []);
    const existing = rows.find((r) => r.Target === target);
    const payload = {
      Id: existing ? existing.Id : "vid_" + Date.now().toString(36),
      YouTubeId: youtubeId, Target: target, TargetLabel: targetLabel, Title: title,
      CreatedAt: new Date().toISOString(),
    };
    if (existing) {
      await updateRow(TAB, existing._row, payload);
    } else {
      await appendRow(TAB, payload);
    }
    return NextResponse.json({ ok: true, youtubeId, target });
  } catch (e) {
    return NextResponse.json({ error: e.message || "فشل حفظ الفيديو في الشيت" }, { status: 500 });
  }
}

export async function DELETE(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  const row = parseInt(new URL(req.url).searchParams.get("row"), 10);
  if (!row) return NextResponse.json({ error: "رقم صف غير صالح" }, { status: 400 });
  try {
    const TAB = await ensureDemoVideosTab();
    await deleteRow(TAB, row);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message || "فشل الحذف" }, { status: 500 });
  }
}

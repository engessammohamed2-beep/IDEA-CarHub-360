import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { geminiGenerate } from "@/lib/aiSettings";
import { readSheet, appendRow, updateRow, getSheetsClient, SHEET_ID, supabaseEnabled } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const TAB = "DealerSchedules";
const HEADERS = ["Brand", "Model", "Year", "Schedule", "UpdatedAt"];

async function ensureTab() {
  if (supabaseEnabled()) return TAB;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${TAB}!A1:E1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] },
    });
  }
  return TAB;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function findCached(brand, model, year) {
  try {
    await ensureTab();
    const rows = await readSheet(TAB);
    const nb = normalize(brand), nm = normalize(model);
    // مطابقة ماركة + موديل (السنة احتياطية — نسخة مقاربة كافية)
    const hit = rows.find((r) =>
      normalize(r.Brand) === nb && normalize(r.Model) === nm
    );
    if (hit && hit.Schedule) {
      return { rows, hit, cached: JSON.parse(hit.Schedule) };
    }
    return { rows, hit: null, cached: null };
  } catch {
    return { rows: [], hit: null, cached: null };
  }
}

async function fetchFromGemini(brand, model, year) {
  const prompt =
`انت خبير صيانات توكيلات السيارات في مصر.
المطلوب: هات جدول صيانات التوكيل الرسمي بالتفصيل للعربية: ${brand} ${model} ${year}
رجعلي JSON Array بالشكل ده بالظبط، مفيش كلام بره الـ JSON:
[
  {
    "brand": "${brand}",
    "model": "${model}",
    "km": 10000,
    "operations": ["تغيير زيت محرك 10W-30", "فلتر زيت", "تربيط عفشة", "فحص كمبيوتر"],
    "parts": ["زيت 3 لتر", "فلتر زيت"],
    "is_major": false
  }
]
الشروط:
- من 10,000 لحد 100,000 كم كل 10 الاف (10 عناصر)
- operations بالعربي العامي بتاع مراكز الخدمة في مصر
- is_major = true في صيانات 40k, 60k, 80k, 100k
- لو في اختلاف بين التوكيل المصري والخليجي، هات المصري
- متخترعش`;

  const r = await geminiGenerate({ prompt, jsonMode: true, timeoutMs: 22000 });
  if (r.error) return { error: r.error };
  try {
    const cleaned = r.text.trim().replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : cleaned);
    if (!Array.isArray(arr) || !arr.length) return { error: "رد Gemini مش صحيح" };
    return { schedule: arr };
  } catch {
    return { error: "فشل تحليل رد Gemini" };
  }
}

// GET /api/dealer-schedule?brand=...&model=...&year=...
export async function GET(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const brand = (searchParams.get("brand") || "").trim();
  const model = (searchParams.get("model") || "").trim();
  const year = (searchParams.get("year") || "").trim();

  if (!brand || !model) return NextResponse.json({ error: "brand و model مطلوبين" }, { status: 400 });

  // 1) كاش الشيت/Supabase
  const { rows, hit, cached } = await findCached(brand, model, year);
  if (cached) return NextResponse.json({ schedule: cached, source: "cache" });

  // 2) Gemini
  const result = await fetchFromGemini(brand, model, year);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 502 });

  // 3) حفظ في الكاش
  try {
    await ensureTab();
    const payload = { Brand: brand, Model: model, Year: year, Schedule: JSON.stringify(result.schedule), UpdatedAt: new Date().toISOString() };
    if (hit && hit._row) await updateRow(TAB, hit._row, payload);
    else await appendRow(TAB, payload);
  } catch (e) {
    console.warn("dealer schedule save:", e.message);
  }

  return NextResponse.json({ schedule: result.schedule, source: "gemini" });
}

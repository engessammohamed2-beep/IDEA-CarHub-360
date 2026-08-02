import { getSheetsClient, SHEET_ID, readSheet, updateRow, appendRow, supabaseEnabled } from "@/lib/googleSheets";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — إعدادات Gemini المركزية
// الأدمن بيحفظ (رابط الـ API + المفتاح + الموديل) من صفحة "إعدادات AI" في
// الإعدادات، وبتتخزن في تاب Google Sheets اسمه AISettings — كل العملاء
// (المواصفات + OCR العداد) بيشتغلوا تلقائياً على نفس الإعدادات المحفوظة.
// لو مفيش حاجة محفوظة، بنرجع لقيم .env كـ fallback.
// -----------------------------------------------------------------------------

const TAB = process.env.SHEET_TAB_AI_SETTINGS || "AISettings";
const HEADERS = ["GeminiApiUrl", "GeminiApiKey", "GeminiModel", "UpdatedAt"];

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60 * 1000;

export function defaultAISettings() {
  return {
    apiUrl:
      process.env.GEMINI_API_URL ||
      "https://generativelanguage.googleapis.com/v1beta",
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  };
}

async function ensureTab() {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${TAB}!A1:D1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] },
    });
  }
  return TAB;
}

/** يرجّع الإعدادات الفعالة: المحفوظة في الشيت، أو .env كـ fallback. */
export async function getAISettings() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  const def = defaultAISettings();
  try {
    if (!supabaseEnabled()) await ensureTab();
    const rows = await readSheet(TAB);
    const row = rows[0] || {};
    _cache = {
      apiUrl: (row.GeminiApiUrl || "").trim() || def.apiUrl,
      apiKey: (row.GeminiApiKey || "").trim() || def.apiKey,
      model: (row.GeminiModel || "").trim() || def.model,
      updatedAt: row.UpdatedAt || null,
      savedInSheet: !!(row.GeminiApiUrl || row.GeminiApiKey || row.GeminiModel),
      _row: row._row,
    };
    _cacheAt = now;
    return _cache;
  } catch (e) {
    console.warn("AISettings: تعذرت القراءة، هنستخدم .env:", e.message);
    return { ...def, savedInSheet: false };
  }
}

/** يحفظ الإعدادات في الشيت (صف واحد ثابت A2:D2) ويمسح الكاش. */
export async function saveAISettings({ apiUrl, apiKey, model }) {
  if (!supabaseEnabled()) await ensureTab();
  const rows = await readSheet(TAB);
  const payload = {
    GeminiApiUrl: apiUrl || "",
    GeminiApiKey: apiKey || "",
    GeminiModel: model || "",
    UpdatedAt: new Date().toISOString(),
  };
  if (rows[0] && rows[0]._row) await updateRow(TAB, rows[0]._row, payload);
  else await appendRow(TAB, payload);
  _cache = null;
  return true;
}

/** نداء generateContent موحّد بالإعدادات المحفوظة (نص و/أو صورة). */
export async function geminiGenerate({ prompt, imageBase64, imageMediaType, modelOverride, jsonMode = true, timeoutMs = 45000 }) {
  const s = await getAISettings();
  if (!s.apiKey) return { error: "مفيش مفتاح Gemini محفوظ (لا في الإعدادات ولا في .env)" };
  const model = modelOverride || s.model;
  const base = s.apiUrl.replace(/\/+$/, "");
  // بنبعت المفتاح بالطريقتين (header + query) — الجديد AQ. والقديم AIza الاتنين بيشتغلوا كده
  const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(s.apiKey)}`;

  const parts = [];
  if (imageBase64) parts.push({ inline_data: { mime_type: imageMediaType || "image/jpeg", data: imageBase64 } });
  parts.push({ text: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": s.apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: jsonMode
          ? { temperature: 0.2, responseMimeType: "application/json" }
          : { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `Gemini (${model}) رجع خطأ ${res.status}: ${t.slice(0, 300)}`, status: res.status, model };
    }
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return { text, model };
  } catch (e) {
    return { error: e.name === "AbortError" ? `مهلة الاتصال انتهت (${model})` : `تعذر الاتصال: ${e.message}`, model };
  } finally {
    clearTimeout(timer);
  }
}

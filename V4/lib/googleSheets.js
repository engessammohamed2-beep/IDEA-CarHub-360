import { google } from "googleapis";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — Google Sheets Data Layer
// Node.js runtime only (googleapis لا يشتغل على Edge Runtime)
// -----------------------------------------------------------------------------

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!email || !key) {
    throw new Error(
      "Missing Google Service Account credentials. تأكد من ضبط GOOGLE_SERVICE_ACCOUNT_EMAIL و GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY."
    );
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

export const SHEET_ID = () => process.env.GOOGLE_SHEET_ID;

// Convert a sheet's raw rows (array of arrays, first row = headers) into
// an array of objects keyed by header name. Keeps the row's 1-based sheet
// row number under `_row` so callers can update/delete precisely.
function rowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  const [headers, ...data] = rows;
  return data
    .map((row, i) => {
      const obj = { _row: i + 2 }; // +2 = skip header row, 1-indexed sheet rows
      headers.forEach((h, idx) => {
        obj[h.trim()] = row[idx] !== undefined ? row[idx] : "";
      });
      return obj;
    })
    .filter((obj) => Object.values(obj).some((v) => v !== "" && v !== obj._row)); // skip fully empty rows
}

/** Read an entire tab as an array of row-objects keyed by header. */
export async function googleReadSheet(tabName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A:Z`,
  });
  return rowsToObjects(res.data.values || []);
}

/** Read just the header row of a tab, in order. */
export async function readHeaders(tabName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!1:1`,
  });
  return (res.data.values && res.data.values[0]) || [];
}

/** Append a new row built from an object, following the tab's existing header order. */
async function googleAppendRow(tabName, rowObject) {
  const sheets = getSheetsClient();
  const headers = await readHeaders(tabName);
  const row = headers.map((h) => (rowObject[h.trim()] !== undefined ? rowObject[h.trim()] : ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  return rowObject;
}

/** Update specific fields of a single row (found via `_row`, obtained from readSheet). */
async function googleUpdateRow(tabName, rowNumber, patch) {
  const sheets = getSheetsClient();
  const headers = await readHeaders(tabName);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A${rowNumber}:Z${rowNumber}`,
  });
  const current = (res.data.values && res.data.values[0]) || [];

  const merged = headers.map((h, idx) => {
    const key = h.trim();
    if (Object.prototype.hasOwnProperty.call(patch, key)) return patch[key];
    return current[idx] !== undefined ? current[idx] : "";
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A${rowNumber}:Z${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [merged] },
  });
  return true;
}

/** Delete a row entirely (needs the tab's internal sheetId, not its name). */
async function googleDeleteRow(tabName, rowNumber) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const tab = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: tab.properties.sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
  return true;
}

/** Ensure the Licenses tab exists with the correct headers; creates it if missing. */
async function _g_ensureLicensesTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_LICENSES || "Licenses";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:I1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "Code",
            "Client Name",
            "Phone",
            "Created At",
            "Expiry Date",
            "Allowed Cars",
            "Allowed Pages",
            "Status",
            "Device ID",
            "Role",
          ],
        ],
      },
    });
  }
  return tabName;
}

/** Ensure the ClientData tab exists (stores each client's full app-data JSON blob, one row per license code). */
async function _g_ensureClientDataTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_CLIENT_DATA || "ClientData";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:C1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Code", "DataJSON", "UpdatedAt"]] },
    });
  }
  return tabName;
}

/** Ensure the SharedModels tab exists (brand/model pairs contributed by all clients, used for autocomplete suggestions). */
async function _g_ensureSharedModelsTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_SHARED_MODELS || "SharedModels";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:B1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Brand", "Model"]] },
    });
  }
  return tabName;
}

/** Ensure the CarSpecs tab exists (admin-curated maintenance specs per engine type). */
async function _g_ensureCarSpecsTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_CAR_SPECS || "CarSpecs";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:N1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "EngineType",
            "MotorOil",
            "MotorOilInterval",
            "TransOil",
            "TransOilInterval",
            "SparkPlug",
            "SparkPlugInterval",
            "TimingBelt",
            "TimingBeltInterval",
            "PowerSteeringOil",
            "PowerSteeringInterval",
            "BrakeFluid",
            "BrakeFluidInterval",
            "Notes",
          ],
        ],
      },
    });
  } else {
    // الشيت موجود من قبل (نسخة أقدم) - نضيف أعمدة BrakeFluid لو مش موجودة، من غير ما نمسح أي بيانات
    const headers = await readHeaders(tabName);
    if (!headers.includes("BrakeFluid")) {
      const newHeaders = [...headers, "BrakeFluid", "BrakeFluidInterval"];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${tabName}!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newHeaders] },
      });
    }
  }
  return tabName;
}

/** Ensure the CarSpecsCache tab exists (24h cache of brand+model+year -> resolved engine type, to avoid hammering CarQuery). */
async function _g_ensureCarSpecsCacheTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_CAR_SPECS_CACHE || "CarSpecsCache";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:F1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Brand", "Model", "Year", "EngineType", "FuelCapL", "CachedAt"]] },
    });
  } else {
    const headers = await readHeaders(tabName);
    if (!headers.includes("FuelCapL")) {
      // نضيف عمود سعة التانك في آخر الأعمدة الحالية (قبل CachedAt لو موجود، وإلا في الآخر) من غير ما نمسح بيانات قديمة
      const cachedAtIdx = headers.indexOf("CachedAt");
      const newHeaders =
        cachedAtIdx === -1
          ? [...headers, "FuelCapL"]
          : [...headers.slice(0, cachedAtIdx), "FuelCapL", ...headers.slice(cachedAtIdx)];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${tabName}!A1:${String.fromCharCode(65 + newHeaders.length - 1)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newHeaders] },
      });
    }
  }
  return tabName;
}

/**
 * Ensure the CarSpecsCatalog tab exists — هنا بنحفظ أي عربية "اتعلمناها" من Gemini
 * (موديل جديد أو سنة جديدة ملقيناهاش في الـ 32 ملف الأصليين).
 * بنستخدم Google Sheets بدل كتابة ملفات على السيرفر عشان الاستضافات الحديثة (Vercel
 * وشبهها) بتشغّل الكود على نظام ملفات read-only وقت الـ runtime، فأي ملف نكتبه
 * هيتمسح تاني أول ما يعمل deploy جديد. الشيت هو المكان الوحيد المضمون إنه دائم.
 */
async function _g_ensureCarSpecsCatalogTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_CAR_SPECS_CATALOG || "CarSpecsCatalog";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:U1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "Brand",
            "Model",
            "YearRange",
            "ModelCode",
            "EngineTypes",
            "TransTypes",
            "FuelTankL",
            "TireSizes",
            "MotorOilType",
            "MotorOilIntervalKm",
            "TransOilType",
            "TransOilIntervalKm",
            "PowerSteeringOil",
            "SparkPlugType",
            "SparkPlugIntervalKm",
            "BrakeFluidType",
            "BrakeFluidIntervalKm",
            "CoolantType",
            "CoolantIntervalKm",
            "TimingBeltType",
            "TimingBeltIntervalKm",
            "FuelFilterIntervalKm",
            "AirFilterIntervalKm",
            "BrakePadsIntervalKm",
            "ServiceSchedule10k",
            "Notes",
            "Source",
            "CreatedAt",
          ],
        ],
      },
    });
  } else {
    // الشيت موجود من نسخة أقدم — نضيف أعمدة بروميت Gemini الجديد (سير الكاتينة،
    // الفلاتر، تيل الفرامل، جدول الـ 10 آلاف كم) من غير ما نمسح أي بيانات قديمة.
    const headers = await readHeaders(tabName);
    const wanted = ["CoolantIntervalKm","TimingBeltType","TimingBeltIntervalKm","FuelFilterIntervalKm","AirFilterIntervalKm","BrakePadsIntervalKm","ServiceSchedule10k"];
    const missing = wanted.filter((h) => !headers.includes(h));
    if (missing.length) {
      const newHeaders = [...headers, ...missing];
      const colLetter = (n) => { let s = ""; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${tabName}!A1:${colLetter(newHeaders.length)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newHeaders] },
      });
    }
  }
  return tabName;
}

/**
 * Ensure the WhatsAppMessages tab exists — سجل كل الرسائل الواردة من العميل
 * والصادرة من البوت، يتعرض live في صفحة /client/dashboard/whatsapp-messages.
 * صف واحد لكل رسالة (مش JSON blob) عشان يبقى سهل نعرضه كشات ونعمله polling.
 */
async function _g_ensureWhatsAppMessagesTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_WHATSAPP_MESSAGES || "WhatsAppMessages";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:H1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "Timestamp",
            "Phone",
            "ClientCode",
            "ClientName",
            "Direction", // "in" (من العميل) أو "out" (من البوت)
            "MessageType", // text / interactive_list / interactive_reply / button / template
            "Content",
            "RawJSON",
          ],
        ],
      },
    });
  }
  return tabName;
}

// تاب Users — نفس التاب اللي الأسكربت (Google Apps Script) بيستخدمه لربط
// chatId (تليجرام أو واتساب) بكود الترخيص. بنستخدم نفس التاب هنا عشان
// نتجنب تكرار البيانات في مكانين، ولو حد فتح البوت من التليجرام برضه
// (مش بس الواتساب اللي بيشتغل من قبل كده)، بيتسجل في نفس المكان الموحّد.
async function _g_ensureUsersTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_USERS || "Users";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:E1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["chatId", "code", "ownerName", "linkedAt", "waPhone"]],
      },
    });
  }
  return tabName;
}
export async function ensureUsersTab() {
  if (!supabaseEnabled()) return _g_ensureUsersTab();
  try { return await _g_ensureUsersTab(); } catch (e) {
    console.warn("ensure tab backup failed:", e.message);
    return "Users";
  }
}



// ═══════════════════════════════════════════════════════════════════════════
//  SUPABASE PRIMARY + GOOGLE SHEETS BACKUP
//  لو SUPABASE_URL و SUPABASE_SERVICE_KEY متظبطين في .env:
//    - كل القراءة والكتابة بتتم على Supabase (جدول sheet_rows)
//    - أول قراءة لأي تاب فاضي في Supabase بتهاجر بياناته من الشيت تلقائياً
//    - كل كتابة بتتنسخ للشيت في الخلفية كـ Backup (لو فشلت مش بتعطل حاجة)
//  لو مش متظبطين: كل حاجة بتشتغل على الشيت زي زمان بالظبط.
// ═══════════════════════════════════════════════════════════════════════════
const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// ملاحظة مهمة: Supabase اتقفل عمدًا (مش بس مش متظبط) — كان بيسبب مشكلة حقيقية:
// البيانات كانت بتتهاجر مرة واحدة من جوجل شيت لـ Supabase، وبعدها البرنامج
// بيقرا من نسخة Supabase المنفصلة دي بس، فأي تعديل مباشر في جوجل شيت (زي مسح
// صف قديم) كان مالوش أي تأثير خالص على اللي البرنامج فعليًا بيعرضه. جوجل شيت
// دلوقتي هو المصدر الوحيد المباشر مرة تانية، زي الوضع الأصلي قبل إضافة Supabase.
export const supabaseEnabled = () => false;

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY(),
      Authorization: `Bearer ${SB_KEY()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${t.slice(0, 250)}`);
  }
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function fireBackup(fn, label) {
  // نسخ احتياطي للشيت في الخلفية — فشله ما يعطلش التطبيق
  Promise.resolve()
    .then(fn)
    .catch((e) => console.warn(`Sheets backup failed (${label}):`, e.message));
}

export async function readSheet(tabName) {
  if (!supabaseEnabled()) return googleReadSheet(tabName);
  const rows = await sb(
    `sheet_rows?tab=eq.${encodeURIComponent(tabName)}&order=row_num.asc&select=row_num,data`
  );
  if (rows && rows.length) return rows.map((r) => ({ ...r.data, _row: r.row_num }));
  // تاب فاضي في Supabase → نهاجر بياناته من جوجل شيت مرة واحدة
  console.log(`[readSheet] تاب "${tabName}" فاضي في Supabase — بنحاول نهاجره من جوجل شيت الآن`);
  try {
    const legacy = await googleReadSheet(tabName);
    console.log(`[readSheet] جوجل شيت رجّع ${legacy.length} صف لتاب "${tabName}"`);
    if (legacy.length) {
      await sb("sheet_rows", {
        method: "POST",
        body: JSON.stringify(
          legacy.map((o) => {
            const { _row, ...data } = o;
            return { tab: tabName, row_num: _row, data };
          })
        ),
      });
      console.log(`[migrate] نقلنا ${legacy.length} صف من تاب ${tabName} إلى Supabase`);
      return legacy;
    }
  } catch (e) {
    console.warn(`[migrate] تعذر قراءة ${tabName} من الشيت:`, e.message, e.stack);
  }
  return [];
}

export async function appendRow(tabName, rowObject) {
  if (!supabaseEnabled()) return googleAppendRow(tabName, rowObject);
  await readSheet(tabName); // يضمن الهجرة الأولى قبل حساب رقم الصف
  const last = await sb(
    `sheet_rows?tab=eq.${encodeURIComponent(tabName)}&order=row_num.desc&limit=1&select=row_num`
  );
  const next = last && last.length ? last[0].row_num + 1 : 2; // 1 محجوز للهيدر زي الشيت
  await sb("sheet_rows", {
    method: "POST",
    body: JSON.stringify([{ tab: tabName, row_num: next, data: rowObject }]),
  });
  fireBackup(() => googleAppendRow(tabName, rowObject), `append ${tabName}`);
  return rowObject;
}

export async function updateRow(tabName, rowNumber, patch) {
  if (!supabaseEnabled()) return googleUpdateRow(tabName, rowNumber, patch);
  const cur = await sb(
    `sheet_rows?tab=eq.${encodeURIComponent(tabName)}&row_num=eq.${rowNumber}&select=data`
  );
  const merged = { ...((cur && cur[0] && cur[0].data) || {}), ...patch };
  await sb(`sheet_rows?tab=eq.${encodeURIComponent(tabName)}&row_num=eq.${rowNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ data: merged, updated_at: new Date().toISOString() }),
  });
  fireBackup(() => googleUpdateRow(tabName, rowNumber, patch), `update ${tabName}#${rowNumber}`);
  return true;
}

export async function deleteRow(tabName, rowNumber) {
  if (!supabaseEnabled()) return googleDeleteRow(tabName, rowNumber);
  await sb(`sheet_rows?tab=eq.${encodeURIComponent(tabName)}&row_num=eq.${rowNumber}`, { method: "DELETE" });
  fireBackup(() => googleDeleteRow(tabName, rowNumber), `delete ${tabName}#${rowNumber}`);
  return true;
}

export async function ensureCarSpecsCacheTab() {
  if (!supabaseEnabled()) return _g_ensureCarSpecsCacheTab();
  try { return await _g_ensureCarSpecsCacheTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "CarSpecsCache";
  }
}

export async function ensureCarSpecsCatalogTab() {
  if (!supabaseEnabled()) return _g_ensureCarSpecsCatalogTab();
  try { return await _g_ensureCarSpecsCatalogTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "CarSpecsCatalog";
  }
}

export async function ensureCarSpecsTab() {
  if (!supabaseEnabled()) return _g_ensureCarSpecsTab();
  try { return await _g_ensureCarSpecsTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "CarSpecs";
  }
}

export async function ensureClientDataTab() {
  if (!supabaseEnabled()) return _g_ensureClientDataTab();
  try { return await _g_ensureClientDataTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "ClientData";
  }
}

export async function ensureLicensesTab() {
  if (!supabaseEnabled()) return _g_ensureLicensesTab();
  try { return await _g_ensureLicensesTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "Licenses";
  }
}

// فيديوهات الديمو (شرح استخدام الصفحات/أنواع الصيانة) — لينكات يوتيوب بس،
// مفيش أي ملفات هنا. لازم التاب يتعمل بعناوينه الأول قبل أي appendRow/readSheet،
// لأن Google Sheets API بيرمي استثناء حقيقي (مش [] فاضية) لو التاب مش موجود
// خالص، وده كان بيسبب "رد فاضي / كود 500" وقت أول محاولة رفع فيديو.
async function _g_ensureDemoVideosTab() {
  const sheets = getSheetsClient();
  const tabName = process.env.SHEET_TAB_DEMO_VIDEOS || "DemoVideos";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1:F1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Id", "YouTubeId", "Target", "TargetLabel", "Title", "CreatedAt"]],
      },
    });
  }
  return tabName;
}
export async function ensureDemoVideosTab() {
  if (!supabaseEnabled()) return _g_ensureDemoVideosTab();
  try { return await _g_ensureDemoVideosTab(); } catch (e) {
    console.warn("ensure tab backup failed:", e.message);
    return "DemoVideos";
  }
}

export async function ensureSharedModelsTab() {
  if (!supabaseEnabled()) return _g_ensureSharedModelsTab();
  try { return await _g_ensureSharedModelsTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "SharedModels";
  }
}

export async function ensureWhatsAppMessagesTab() {
  if (!supabaseEnabled()) return _g_ensureWhatsAppMessagesTab();
  try { return await _g_ensureWhatsAppMessagesTab(); } catch (e) {
    // Supabase هو الأساسي — لو الشيت (الباك اب) واقع منوقفش التطبيق
    console.warn("ensure tab backup failed:", e.message);
    return "WhatsAppMessages";
  }
}

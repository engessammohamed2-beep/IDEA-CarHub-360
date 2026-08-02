import fs from "fs";
import path from "path";
import { readSheet, appendRow, ensureCarSpecsCatalogTab } from "@/lib/googleSheets";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — كتالوج مواصفات الصيانة
// -----------------------------------------------------------------------------
// المصدر الوحيد للمواصفات دلوقتي (مفيش أي API مواصفات سيارات خارجي زي CarQuery):
//   1) الكتالوج الأصلي: ملفات .json ثابتة في data/car-specs-catalog/ (الـ 32 ملف
//      اللي جهزتهم انت + أي ملفات تضيفها بعدين). دول جزء من الكود نفسه.
//   2) الكتالوج "المكتسب": عربيات اتجابت من Gemini API وتحفظت في تاب Google Sheets
//      اسمه CarSpecsCatalog (مش ملفات على السيرفر) عشان تفضل دايمة حتى لو
//      الاستضافة (Vercel وشبهها) بتشغّل الكود على نظام ملفات read-only.
// المرة الجاية اللي حد يسأل عن نفس العربية، بيتلاقاها في المصدر (2) على طول من
// غير ما نضطر ننادي Gemini تاني.
// -----------------------------------------------------------------------------

const CATALOG_DIR = path.join(process.cwd(), "data", "car-specs-catalog");

function normalizeArabic(s) {
  let x = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "") // تشكيل
    .replace(/[\u0623\u0625\u0622\u0627]/g, "\u0627") // أ إ آ ا -> ا
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\u0624/g, "\u0648") // ؤ -> و
    .replace(/\u0626/g, "\u064A") // ئ -> ي
    .replace(/[\u200c\u200f\u200e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // شيل هاء زيادة في آخر الكلمة (بورشه/بورش، شيفروليه/شيفرولية) — أسماء الماركات
  // الأجنبية بتتكتب بالعربي بأكتر من طريقة، وده بيوحّدهم عشان المطابقة تنجح.
  x = x.replace(/ه$/, "");
  return x;
}

/** يحلل "2007-2012" أو "2007" لـ {from, to} أرقام. */
function parseYearRange(yearRange) {
  const s = String(yearRange || "").trim();
  const m = s.match(/(\d{4})\s*-\s*(\d{4})/);
  if (m) return { from: Number(m[1]), to: Number(m[2]) };
  const single = s.match(/(\d{4})/);
  if (single) return { from: Number(single[1]), to: Number(single[1]) };
  return null;
}

function yearInRange(year, yearRange) {
  const y = Number(year);
  const r = parseYearRange(yearRange);
  if (!r || !y) return false;
  return y >= r.from && y <= r.to;
}

// ---------------------------- قراءة الملفات الأصلية ----------------------------

function readOriginalCatalogFiles() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(CATALOG_DIR).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    return out; // المجلد مش موجود — عادي لو لسه محدش ضاف الملفات
  }
  for (const file of files) {
    const full = path.join(CATALOG_DIR, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry && entry.brand && entry.model) {
          out.push({ ...entry, _source: "original", _file: file });
        }
      }
    } catch (e) {
      console.warn(`CarSpecsCatalog: تعذرت قراءة ${file}:`, e.message);
    }
  }
  return out;
}

// ---------------------------- قراءة الـ entries المكتسبة من الشيت ----------------------------

function safeJsonArray(str) {
  if (!str) return [];
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : [v];
  } catch {
    return String(str)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function rowToEntry(row) {
  return {
    brand: row.Brand || "",
    model: row.Model || "",
    year_range: row.YearRange || "",
    model_code: row.ModelCode || "",
    engine_types: safeJsonArray(row.EngineTypes),
    trans_types: safeJsonArray(row.TransTypes),
    fuel_tank_l: row.FuelTankL ? Number(row.FuelTankL) : 0,
    tire_sizes: safeJsonArray(row.TireSizes),
    motor_oil_type: row.MotorOilType || "--",
    motor_oil_interval_km: row.MotorOilIntervalKm ? Number(row.MotorOilIntervalKm) : 0,
    trans_oil_type: row.TransOilType || "--",
    trans_oil_interval_km: row.TransOilIntervalKm ? Number(row.TransOilIntervalKm) : 0,
    power_steering_oil: row.PowerSteeringOil || "--",
    spark_plug_type: row.SparkPlugType || "--",
    spark_plug_interval_km: row.SparkPlugIntervalKm ? Number(row.SparkPlugIntervalKm) : 0,
    brake_fluid_type: row.BrakeFluidType || "--",
    brake_fluid_interval_km: row.BrakeFluidIntervalKm ? Number(row.BrakeFluidIntervalKm) : 0,
    coolant_type: row.CoolantType || "--",
    coolant_interval_km: row.CoolantIntervalKm ? Number(row.CoolantIntervalKm) : 0,
    timing_belt_type: row.TimingBeltType || "--",
    timing_belt_interval_km: row.TimingBeltIntervalKm ? Number(row.TimingBeltIntervalKm) : 0,
    fuel_filter_interval_km: row.FuelFilterIntervalKm ? Number(row.FuelFilterIntervalKm) : 0,
    air_filter_interval_km: row.AirFilterIntervalKm ? Number(row.AirFilterIntervalKm) : 0,
    brake_pads_interval_km: row.BrakePadsIntervalKm ? Number(row.BrakePadsIntervalKm) : 0,
    service_schedule_10k: row.ServiceSchedule10k || "--",
    notes: row.Notes || "--",
    _source: "learned",
    _row: row._row,
  };
}

async function readLearnedEntries() {
  try {
    const tabName = await ensureCarSpecsCatalogTab();
    const rows = await readSheet(tabName);
    return rows.map(rowToEntry);
  } catch (e) {
    console.warn("CarSpecsCatalog: تعذرت قراءة الكتالوج المكتسب من الشيت:", e.message);
    return [];
  }
}

// كاش بسيط في الميموري للملفات الأصلية بس (ثابتة، مش هتتغير أثناء التشغيل).
let _originalCache = null;
function getOriginalEntries() {
  if (!_originalCache) _originalCache = readOriginalCatalogFiles();
  return _originalCache;
}

/** يرجّع كل entries الكتالوج (الأصلية من الملفات + المكتسبة من الشيت). */
export async function loadCatalog() {
  const original = getOriginalEntries();
  const learned = await readLearnedEntries();
  return [...original, ...learned];
}

/**
 * مطابقة على 3 مستويات: brand + model + year (لازم السنة تقع جوه year_range).
 * بعض الموديلات ليها أكتر من فيرجن/موتور لنفس السنوات (مثلاً تنفس طبيعي مقابل
 * تيربو) — دي بترجع **كل** التطابقات عشان الطبقة اللي فوق تقرر: لو واحد بس،
 * تستخدمه على طول؛ لو أكتر من واحد، تسأل العميل يحدد أي فيرجن عربيته.
 */
export async function findAllCatalogMatches(brand, model, year) {
  const nb = normalizeArabic(brand);
  const nm = normalizeArabic(model);
  const catalog = await loadCatalog();

  const brandModelMatches = catalog.filter(
    (e) => normalizeArabic(e.brand) === nb && normalizeArabic(e.model) === nm
  );

  return brandModelMatches.filter((entry) => yearInRange(year, entry.year_range));
}

/**
 * توافقًا مع الاستخدام القديم: برجّع أول entry مطابق بس، أو null لو مفيش.
 * الأفضل استخدام findAllCatalogMatches لو محتاج تتعامل مع أكتر من فيرجن.
 */
export async function findCatalogEntry(brand, model, year) {
  const matches = await findAllCatalogMatches(brand, model, year);
  return matches.length ? matches[0] : null;
}

/** كل الـ entries لماركة+موديل معينين (بغض النظر عن السنة) — يفيد في تمييز "مش لاقي السنة" عن "مش لاقي الموديل خالص". */
export async function findBrandModelEntries(brand, model) {
  const nb = normalizeArabic(brand);
  const nm = normalizeArabic(model);
  const catalog = await loadCatalog();
  return catalog.filter((e) => normalizeArabic(e.brand) === nb && normalizeArabic(e.model) === nm);
}

/** هل الماركة موجودة أصلاً في الكتالوج (أي موديل)؟ */
export async function brandExistsInCatalog(brand) {
  const nb = normalizeArabic(brand);
  const catalog = await loadCatalog();
  return catalog.some((e) => normalizeArabic(e.brand) === nb);
}

/**
 * يحفظ entry جديد (من Gemini) في تاب CarSpecsCatalog بالشيت، عشان المرة الجاية
 * يتلاقى في الكتالوج على طول من غير ما نضطر ننادي Gemini تاني لنفس العربية.
 */
export async function saveLearnedEntry(entry, source = "gemini") {
  const tabName = await ensureCarSpecsCatalogTab();
  const payload = {
    Brand: entry.brand || "",
    Model: entry.model || "",
    YearRange: entry.year_range || "",
    ModelCode: entry.model_code || "",
    EngineTypes: JSON.stringify(entry.engine_types || []),
    TransTypes: JSON.stringify(entry.trans_types || []),
    FuelTankL: entry.fuel_tank_l != null ? String(entry.fuel_tank_l) : "",
    TireSizes: JSON.stringify(entry.tire_sizes || []),
    MotorOilType: entry.motor_oil_type || "--",
    MotorOilIntervalKm: entry.motor_oil_interval_km != null ? String(entry.motor_oil_interval_km) : "0",
    TransOilType: entry.trans_oil_type || "--",
    TransOilIntervalKm: entry.trans_oil_interval_km != null ? String(entry.trans_oil_interval_km) : "0",
    PowerSteeringOil: entry.power_steering_oil || "--",
    SparkPlugType: entry.spark_plug_type || "--",
    SparkPlugIntervalKm: entry.spark_plug_interval_km != null ? String(entry.spark_plug_interval_km) : "0",
    BrakeFluidType: entry.brake_fluid_type || "--",
    BrakeFluidIntervalKm: entry.brake_fluid_interval_km != null ? String(entry.brake_fluid_interval_km) : "0",
    CoolantType: entry.coolant_type || "--",
    CoolantIntervalKm: entry.coolant_interval_km != null ? String(entry.coolant_interval_km) : "0",
    TimingBeltType: entry.timing_belt_type || "--",
    TimingBeltIntervalKm: entry.timing_belt_interval_km != null ? String(entry.timing_belt_interval_km) : "0",
    FuelFilterIntervalKm: entry.fuel_filter_interval_km != null ? String(entry.fuel_filter_interval_km) : "0",
    AirFilterIntervalKm: entry.air_filter_interval_km != null ? String(entry.air_filter_interval_km) : "0",
    BrakePadsIntervalKm: entry.brake_pads_interval_km != null ? String(entry.brake_pads_interval_km) : "0",
    ServiceSchedule10k: entry.service_schedule_10k || "--",
    Notes: entry.notes || "--",
    Source: source,
    CreatedAt: new Date().toISOString(),
  };
  await appendRow(tabName, payload);
  return true;
}

export { normalizeArabic, parseYearRange, yearInRange };

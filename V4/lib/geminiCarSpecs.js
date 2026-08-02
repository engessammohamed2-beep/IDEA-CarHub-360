// -----------------------------------------------------------------------------
// IDEA CarHub 360 — جلب مواصفات صيانة عربية من Gemini API لما الكتالوج المحلي
// (الـ 32 ملف + الكتالوج المكتسب) ملقيش العربية.
// -----------------------------------------------------------------------------
// المتطلب الوحيد: GEMINI_API_KEY في .env (مفتاح مجاني من https://aistudio.google.com/apikey)
// -----------------------------------------------------------------------------

import { geminiGenerate } from "@/lib/aiSettings";

function buildPrompt(brand, model, year) {
  return `انت خبير صيانة سيارات معتمد في مصر والخليج. معاك كل كتالوجات الوكلاء من 2000 لحد 2025.
هات جدول صيانة كامل للموديل ده: ${brand} ${model} ${year}
رجع JSON فيه: المحرك، الفتيس، سير الكاتينة بيتغير كل كام، زيت الفتيس كل كام، البوجيهات، فلتر البنزين، فلتر الهواء، مياه التبريد، تيل الفرامل، وفترات الصيانة كل 10 الاف كم.
لو مش متأكد حط --

رجع JSON فقط بالشكل ده بدون أي شرح:
{
  "brand": "",
  "model": "",
  "model_code": "",
  "year_range": "",
  "engine_types": [],
  "trans_types": [],
  "fuel_tank_l": 0,
  "tire_sizes": [],
  "tire_size_catalog": "",
  "tire_interval_km": 0,
  "tire_interval_months": 0,
  "motor_oil_type": "",
  "motor_oil_interval_km": 0,
  "trans_oil_type": "",
  "trans_oil_interval_km": 0,
  "timing_belt_type": "",
  "timing_belt_interval_km": 0,
  "power_steering_oil": "",
  "spark_plug_type": "",
  "spark_plug_interval_km": 0,
  "fuel_filter_interval_km": 0,
  "air_filter_interval_km": 0,
  "brake_pads_interval_km": 0,
  "brake_fluid_type": "",
  "brake_fluid_interval_km": 0,
  "coolant_type": "",
  "coolant_interval_km": 0,
  "service_schedule_10k": "",
  "notes": ""
}
قواعد: ابدأ من سنة 2000 بس، لو مش متأكد حط --، فترات التغيير بالكيلومتر حسب كتالوج الوكيل في مصر والخليج، و"service_schedule_10k" اكتب فيها ملخص فترات الصيانة كل 10 آلاف كم (10/20/30/40 ألف).
بخصوص الإطارات (الكاوتش):
- "tire_size_catalog": المقاس الرسمي في كتالوج الشركة بالصيغة دي بالظبط: 185/65R15 91H (العرض/النسبة R قطر الجنط + مؤشر الحمل + رمز السرعة). لو فيه أكتر من مقاس حط الأساسي.
- "tire_interval_km": الكيلومترات اللي بعدها يُنصح بتغيير الكاوتش (رقم فقط، عادة بين 40000 و60000).
- "tire_interval_months": المدة بالشهور اللي بعدها يُنصح بالتغيير حتى لو الكيلومترات قليلة (عادة 60 شهر = 5 سنين).
رجع JSON فقط بدون شرح`;
}

/** يشيل ```json fences``` لو Gemini حطها رغم التعليمات، ويطلّع أول object JSON صحيح. */
function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isValidSpecResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!obj.brand || !obj.model) return false;
  return true;
}

/**
 * ينادي Gemini API ويرجّع entry بنفس شكل entries الكتالوج، أو {error} لو فشل.
 * brand/model بيتبعتوا زي ما العميل كتبهم بالظبط (عربي)، وyear هو السنة اللي دخلها.
 */
export async function fetchSpecsFromGemini(brand, model, year) {
  const prompt = buildPrompt(brand, model, year);
  // بننادي Gemini بالإعدادات المحفوظة من صفحة الأدمن (رابط/مفتاح/موديل)
  const gen = await geminiGenerate({ prompt, jsonMode: true });
  if (gen.error) return { error: gen.error };
  const text = gen.text;
  {
    const parsed = extractJson(text);
    if (!isValidSpecResult(parsed)) {
      return { error: "رد Gemini مش بالشكل المتوقع" };
    }

    if (!parsed.year_range || !/\d{4}/.test(parsed.year_range)) {
      parsed.year_range = String(year);
    }

    return { entry: parsed };
  }
}

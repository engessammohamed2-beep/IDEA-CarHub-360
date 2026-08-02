import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import {
  findAllCatalogMatches,
  findBrandModelEntries,
  brandExistsInCatalog,
  saveLearnedEntry,
} from "@/lib/carSpecsCatalog";
import { fetchSpecsFromGemini } from "@/lib/geminiCarSpecs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// -----------------------------------------------------------------------------
// منطق جلب مواصفات الصيانة (بدون أي API مواصفات سيارات خارجي — CarQuery وغيره اتلغى):
//
//   1) دوّر في الكتالوج المحلي (الـ 32 ملف + أي عربيات "مكتسبة" اتحفظت قبل كده).
//      مطابقة على 3 مستويات: ماركة + موديل + نطاق السنة (year_range).
//   2) لو الماركة+الموديل موجودين بس السنة اللي دخلها العميل مش في أي نطاق مسجل:
//      ابعت لـ Gemini API بنفس بيانات العربية والسنة، واحفظ الرد الجديد في الكتالوج.
//   3) لو الموديل نفسه (أو حتى الماركة) مش موجود خالص: نفس المسار — ابعت لـ Gemini،
//      واحفظ الموديل الجديد بالكامل في الكتالوج عشان يتلاقى تاني على طول.
//   4) لو Gemini فشل (مفتاح مش مضبوط، أو خطأ اتصال): رجّع رسالة واضحة والعميل
//      يقدر يدخل البيانات يدوي وتتحفظ عنده زي أي حالة تانية.
// -----------------------------------------------------------------------------

function emptySpecs() {
  return {
    motorOil: "",
    motorOilInterval: "",
    transOil: "",
    transOilInterval: "",
    sparkPlug: "",
    sparkPlugInterval: "",
    timingBelt: "",
    timingBeltInterval: "",
    powerSteeringOil: "",
    powerSteeringInterval: "",
    brakeFluid: "",
    brakeFluidInterval: "",
    fuelFilterInterval: "",
    airFilterInterval: "",
    brakePadsInterval: "",
    coolant: "",
    coolantInterval: "",
    service10k: "",
    notes: "",
  };
}

// بيحوّل entry الكتالوج (شكل brand/model/year_range/motor_oil_type...) لشكل الـ
// specs اللي الواجهة الأمامية متوقعاه (motorOil/motorOilInterval...) — نفس الشكل
// القديم، عشان الواجهة تفضل شغالة من غير تعديل.
function catalogEntryToSpecs(entry) {
  const dash = (v) => (v === undefined || v === null || v === "" ? "--" : v);
  return {
    motorOil: dash(entry.motor_oil_type),
    motorOilInterval: entry.motor_oil_interval_km ? `${entry.motor_oil_interval_km} كم` : "--",
    transOil: dash(entry.trans_oil_type),
    transOilInterval: entry.trans_oil_interval_km ? `${entry.trans_oil_interval_km} كم` : "--",
    sparkPlug: dash(entry.spark_plug_type),
    sparkPlugInterval: entry.spark_plug_interval_km ? `${entry.spark_plug_interval_km} كم` : "--",
    timingBelt: dash(entry.timing_belt_type),
    timingBeltInterval: entry.timing_belt_interval_km ? `${entry.timing_belt_interval_km} كم` : "--",
    powerSteeringOil: dash(entry.power_steering_oil),
    powerSteeringInterval: "",
    brakeFluid: dash(entry.brake_fluid_type),
    brakeFluidInterval: entry.brake_fluid_interval_km ? `${entry.brake_fluid_interval_km} كم` : "--",
    fuelFilterInterval: entry.fuel_filter_interval_km ? `${entry.fuel_filter_interval_km} كم` : "--",
    airFilterInterval: entry.air_filter_interval_km ? `${entry.air_filter_interval_km} كم` : "--",
    brakePadsInterval: entry.brake_pads_interval_km ? `${entry.brake_pads_interval_km} كم` : "--",
    coolant: dash(entry.coolant_type),
    coolantInterval: entry.coolant_interval_km ? `${entry.coolant_interval_km} كم` : "--",
    service10k: dash(entry.service_schedule_10k),
    notes: dash(entry.notes),
  };
}

function firstEngineType(entry) {
  if (Array.isArray(entry.engine_types) && entry.engine_types.length) return entry.engine_types[0];
  return null;
}

const NOT_FOUND_MESSAGE =
  "لم يتم العثور على هذه السيارة. تأكد من الماركة والموديل والسنة أو ادخل البيانات يدوياً";

export async function GET(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const brand = (searchParams.get("brand") || "").trim();
    const model = (searchParams.get("model") || "").trim();
    const year = (searchParams.get("year") || "").trim();
    // لو العميل اختار فيرجن/موتور معين بعد ما شفناله أكتر من خيار (نبعتلوه modelCode
    // في الرد الأول، وهو يرجّعه هنا في النداء الثاني عشان نحدد الـ entry بالظبط).
    const chosenModelCode = (searchParams.get("modelCode") || "").trim();

    if (!brand || !model || !year) {
      return NextResponse.json(
        { found: false, manualEntry: true, message: "اختار الماركة والموديل والسنة الأول" },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------------------
    // (1) دور في الكتالوج المحلي: brand + model + year (جوه year_range)
    // ---------------------------------------------------------------------
    let matches = await findAllCatalogMatches(brand, model, year);
    let entry = null;
    let source = null;

    if (matches.length === 1) {
      entry = matches[0];
      source = "catalog";
    } else if (matches.length > 1) {
      // أكتر من فيرجن/موتور لنفس السنة (مثلاً تنفس طبيعي مقابل تيربو). لو العميل
      // حدد الفيرجن قبل كده، نستخدمها؛ وإلا نرجّع الخيارات عشان يختار.
      if (chosenModelCode) {
        entry = matches.find((m) => String(m.model_code || "") === chosenModelCode) || matches[0];
        source = "catalog";
      } else {
        return NextResponse.json({
          found: true,
          needsTrimChoice: true,
          message: "في أكتر من نسخة/موتور لهذه السيارة في نفس السنة — اختار الأقرب لعربيتك.",
          trimOptions: matches.map((m) => ({
            modelCode: m.model_code || "",
            engineTypes: m.engine_types || [],
            transTypes: m.trans_types || [],
            fuelTankL: m.fuel_tank_l || null,
            notes: m.notes || "",
          })),
        });
      }
    }

    // ---------------------------------------------------------------------
    // (2) و(3): لو مالقيناهاش، ابعت لـ Gemini — سواء السبب إن السنة مش موجودة
    //     لموديل معروف، أو إن الموديل نفسه (أو حتى الماركة) مش موجود خالص.
    // ---------------------------------------------------------------------
    let geminiError = null;
    if (!entry) {
      const existingForModel = await findBrandModelEntries(brand, model);
      const brandKnown = existingForModel.length > 0 || (await brandExistsInCatalog(brand));

      const result = await fetchSpecsFromGemini(brand, model, year);
      if (result.entry) {
        entry = result.entry;
        source = "gemini";
        try {
          await saveLearnedEntry(entry, "gemini");
        } catch (e) {
          console.warn("car-specs: فشل حفظ entry من Gemini:", e.message);
        }
      } else {
        geminiError = result.error || "تعذر جلب البيانات من Gemini";
      }

      if (!entry) {
        const msg = brandKnown
          ? "لم يتم العثور على بيانات هذا الموديل/السنة، ولم نتمكن من جلبها تلقائياً حالياً. تقدر تدخل البيانات يدوياً وتتحفظ."
          : NOT_FOUND_MESSAGE;
        return NextResponse.json({
          found: false,
          manualEntry: true,
          engineType: null,
          fuelCapL: null,
          specs: emptySpecs(),
          message: msg,
          ...(geminiError ? { debugError: geminiError } : {}),
        });
      }
    }

    // ---------------------------------------------------------------------
    // لقينا entry (من الكتالوج المحلي أو من Gemini) — نجهّزه بنفس شكل الرد
    // القديم اللي الواجهة الأمامية متعودة عليه (found/engineType/fuelCapL/specs).
    // ---------------------------------------------------------------------
    const specs = catalogEntryToSpecs(entry);
    const engineType = firstEngineType(entry);
    const fuelCapL = entry.fuel_tank_l ? Number(entry.fuel_tank_l) : null;

    return NextResponse.json({
      found: true,
      source, // "catalog" أو "gemini" — يفيد للتشخيص، الواجهة مش لازم تستخدمه
      engineType: engineType || null,
      fuelCapL: fuelCapL || null,
      modelCode: entry.model_code || null,
      engineTypes: entry.engine_types || [],
      transTypes: entry.trans_types || [],
      tireSizes: entry.tire_sizes || [],
      tireSizeCatalog: entry.tire_size_catalog || "",
      tireIntervalKm: entry.tire_interval_km || 0,
      tireIntervalMonths: entry.tire_interval_months || 0,
      coolantType: entry.coolant_type || null,
      specs,
      message: source === "gemini" ? "تم جلب بيانات هذه السيارة تلقائياً وحفظها لأول مرة." : "",
    });
  } catch (e) {
    return NextResponse.json(
      { found: false, manualEntry: true, specs: emptySpecs(), message: "حصل خطأ أثناء جلب المواصفات" },
      { status: 500 }
    );
  }
}

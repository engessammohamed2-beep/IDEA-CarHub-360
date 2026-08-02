import { readSheet, googleReadSheet, updateRow, appendRow, deleteRow, ensureClientDataTab, ensureLicensesTab } from "@/lib/googleSheets";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — طبقة قراءة بيانات العملاء لصالح تكامل واتساب
// -----------------------------------------------------------------------------
// ملحوظة مهمة عن البنية الحقيقية للبيانات (عشان الفرق واضح عن الطلب الأصلي):
//
//   - مفيش تاب اسمه "Cars" منفصل بأعمدة. بيانات كل عربية (brand, model, km,
//     carLicExp, waPhone...) متخزنة جوه عمود DataJSON في تاب ClientData،
//     كجزء من الكائن الكامل: { cars: [...], maintenance: [...], violations: [...] }.
//   - تاب "Licenses" هو أكواد تفعيل استخدام البرنامج نفسه (Code, Client Name,
//     Phone, Expiry Date...) — مش رخصة قيادة/رخصة سيارة العميل. رخصة السيارة
//     (تاريخ انتهاء الرخصة الفعلية) موجودة في car.carLicExp جوه الـ DataJSON.
//   - المخالفات موجودة في data.violations[] لكل عربية (carId)، مش عمود في
//     تاب Licenses.
//
// كل الدوال هنا بتقرا من المصدر الحقيقي ده (ClientData.DataJSON) عشان تدي
// بيانات دقيقة فعلاً بدل بيانات وهمية من بنية مش موجودة.
// -----------------------------------------------------------------------------

/** فترات الصيانة الدورية (نفس MAINT_DB في public/app/index.html) — نسخة سيرفر-سايد
 *  عشان نحسب "الصيانة الجاية" بنفس منطق الواجهة بالظبط. */
export const MAINT_DB = {
  oil: { name: "زيت الموتور", icon: "🛢️", kmInt: 5000, monInt: 6 },
  "oil-filter": { name: "فلتر الزيت", icon: "🔩", kmInt: 5000, monInt: 6 },
  "air-filter": { name: "فلتر الهوا", icon: "💨", kmInt: 15000, monInt: 12 },
  "fuel-filter": { name: "فلتر البنزين", icon: "⚗️", kmInt: 30000, monInt: 24 },
  spark: { name: "البوجيهات", icon: "⚡", kmInt: 20000, monInt: 24 },
  timing: { name: "سير الكاتينة", icon: "⚙️", kmInt: 80000, monInt: 60 },
  belt: { name: "سير المجموعة", icon: "🔗", kmInt: 50000, monInt: 36 },
  "brake-fluid": { name: "سائل الفرامل", icon: "🛑", kmInt: 30000, monInt: 12 },
  tires: { name: "الكاوتش / الإطارات", icon: "🔵", kmInt: 40000, monInt: 36 },
  coolant: { name: "مية الردياتير", icon: "💧", kmInt: 40000, monInt: 24 },
  gearbox: { name: "زيت الفتيس", icon: "🔄", kmInt: 60000, monInt: 36 },
  power: { name: "زيت الباور", icon: "💪", kmInt: 40000, monInt: 36 },
  "brake-pad": { name: "تيل الفرامل", icon: "🔴", kmInt: 30000, monInt: 12 },
  "ac-filter": { name: "فلتر تكييف", icon: "❄️", kmInt: 20000, monInt: 12 },
  other: { name: "أخرى", icon: "🔨", kmInt: 10000, monInt: 12 },
};

function normalizePhone(phone) {
  // نوحّد صيغة الرقم (نشيل + والمسافات والأصفار البادئة الزيادة) عشان مطابقة الأرقام
  // اللي بتيجي من Meta (بصيغة دولية زي 201001234567) مع اللي العميل كتبه بنفسه.
  return String(phone || "").replace(/[^0-9]/g, "");
}

/**
 * يدور على رقم الواتساب في كل صفوف ClientData (JSON blob لكل عميل)، ويرجّع
 * أول عربية (car) وين الـ waPhone بتاعها بيطابق الرقم، مع بيانات العميل صاحبها.
 * برجّع null لو الرقم مش مسجل عند أي عميل (Error Handling للعميل غير المسجل).
 */

// ─────────────────────────────────────────────────────────
// حل اسم العميل من المصادر الموثوقة بالترتيب:
//  1) Licenses مطابقة بالتليفون (الأدق — عمود Phone)
//  2) Licenses مطابقة بالكود
//  3) اسم صاحب العربية المسجل في التطبيق (آخر حل)
// كده الاسم بيجي من الشيت مش من بيانات قديمة جوه الجهاز
// ─────────────────────────────────────────────────────────
function resolveClientName(licenseRows, code, phone, carOwner) {
  const t9 = (x) => {
    const n = normalizePhone(x);
    return n.length >= 9 ? n.slice(-9) : "";
  };
  const norm = (x) => String(x || "").trim();
  const target = t9(phone);

  // (1) بالتليفون — أقوى مطابقة، بنتجاهل فروق المسافات/الحالة في الكود
  if (target) {
    const byPhone = licenseRows.find((l) => {
      const lp = t9(l.Phone || l.phone || "");
      return lp && lp === target;
    });
    const nm = byPhone && norm(byPhone["Client Name"]);
    if (nm) return nm;
  }
  // (2) بالكود (مطابقة متسامحة: تريم + حروف كبيرة)
  const codeNorm = norm(code).toUpperCase();
  if (codeNorm) {
    const byCode = licenseRows.find((l) => norm(l.Code).toUpperCase() === codeNorm);
    const nm = byCode && norm(byCode["Client Name"]);
    if (nm) return nm;
  }
  // (3) الاسم القديم المخزن جوه بيانات العربية (owner) —
  // ده أضعف مصدر ومحتمل يكون قديم/تجريبي، فبنستخدمه بس لو معندناش أي بديل
  // من Licenses، وبنستبعد صراحة قيم تجريبية معروفة زي "أحمد" الافتراضي.
  const legacy = norm(carOwner);
  const isKnownTestValue = /^(test|تجربة|demo)/i.test(legacy) || legacy === "أحمد";
  if (legacy && !isKnownTestValue) return legacy;
  return "";
}

/**
 * بيحدّث "Client Name" في تاب Licenses مباشرة، وهو المصدر الموحّد اللي كل
 * حاجة (الواتساب، التليجرام، رسالة الصباح) بتقرا الاسم منه. مستخدمة من:
 * - API التطبيق (/api/client/update-name) لما العميل يكتب اسمه في الفورم
 * - بوت الواتساب لما العميل يبعت أمر "اسمي فلان" لتصحيح اسمه بنفسه
 */
export async function updateClientNameInLicenses(code, name) {
  if (!code || !name) return false;
  try {
    const licTab = await ensureLicensesTab();
    const rows = await readSheet(licTab);
    const row = rows.find((l) => l.Code === code);
    if (!row) return false;
    await updateRow(licTab, row._row, { "Client Name": name.trim() });
    return true;
  } catch (e) {
    console.warn("updateClientNameInLicenses error:", e.message);
    return false;
  }
}

// بيدور في تاب Archive عن عميل اتأرشف قبل كده (خمول 30 يوم) بنفس الرقم ده،
// ولو لقاه، بيرجّعه تلقائيًا لـ ClientData بكل بياناته القديمة كاملة —
// مش يسيبه يبدأ تسجيل عربية جديدة من الصفر. ده استرجاع فوري وشفاف تمامًا
// للعميل، بيحصل أول ما يبعت رسالة أو يفتح التطبيق برقمه القديم.
async function tryRestoreFromArchive_(targetPhone, licenseRows) {
  const archiveTab = "Archive";
  const archiveRows = await readSheet(archiveTab).catch(() => []);
  if (!archiveRows.length) return null;

  const t9 = (x) => {
    const n = normalizePhone(x);
    return n.length >= 9 ? n.slice(-9) : "";
  };
  const targetT9 = t9(targetPhone);

  for (const row of archiveRows) {
    if (!row.DataJSON) continue;
    let data;
    try {
      data = JSON.parse(row.DataJSON);
    } catch {
      continue;
    }
    const cars = Array.isArray(data.cars) ? data.cars : [];
    const matchedCar = cars.find((c) => {
      const cand = [c.waPhone, c.ownerPhone].map(normalizePhone).filter((x) => x && x.length >= 9);
      return cand.some((cp) => cp === targetPhone || (targetT9 && t9(cp) === targetT9));
    });
    if (!matchedCar) continue;

    console.log("[tryRestoreFromArchive_] لقينا العميل في الأرشيف — بنرجّعه لـ ClientData:", row.Code);

    // نرجّعه لـ ClientData بنفس بياناته، ونحدّث UpdatedAt لدلوقتي عشان
    // ما يترشحش للأرشفة تاني فورًا في نفس اليوم
    const clientDataTab = await ensureClientDataTab();
    await appendRow(clientDataTab, {
      Code: row.Code,
      DataJSON: row.DataJSON,
      UpdatedAt: new Date().toISOString(),
    });
    // نمسحه من الأرشيف عشان مايفضلش صف "ميت" هناك بعد ما استرجعناه
    if (row._row) await deleteRow(archiveTab, row._row).catch(() => {});

    return {
      code: row.Code,
      name: resolveClientName(licenseRows, row.Code, targetPhone, matchedCar.owner),
      phone: targetPhone,
      car: matchedCar,
      carId: matchedCar.id,
      allCars: cars,
      maintenance: Array.isArray(data.maintenance) ? data.maintenance.filter((m) => m.carId === matchedCar.id) : [],
      violations: Array.isArray(data.violations) ? data.violations.filter((v) => v.carId === matchedCar.id) : [],
      settings: data.settings || {},
      rawData: data,
      _restoredFromArchive: true,
    };
  }
  return null;
}

// بيحفظ سجل تفويلة فعليًا في صف العميل جوه ClientData — ده كان الجزء الناقص
// اللي بيخلي رسايل تسجيل الوقود من الواتساب "بترد بس من غير ما تتسجل فعليًا".
// بيرجع { ok, fuelCapL } — fuelCapL بترجع لو اتعلمت/اتحدثت من فول تانك.
export async function saveFuelRecordToClientData(code, carId, fuelRecord) {
  try {
    const clientDataTab = await ensureClientDataTab();
    const rows = await readSheet(clientDataTab);
    const row = rows.find((r) => r.Code === code);
    if (!row) return { ok: false, error: "الكود مش موجود في ClientData" };

    let data;
    try {
      data = JSON.parse(row.DataJSON);
    } catch {
      return { ok: false, error: "بيانات العميل تالفة" };
    }

    if (!Array.isArray(data.fuel)) data.fuel = [];
    const newRecord = { id: Date.now(), carId, ...fuelRecord };
    data.fuel.push(newRecord);

    // لو دي تعبئة فول تانك ومفيش سعة تانك متسجلة لهذه العربية، نتعلّمها
    // من عدد اللترات ده — عشان الحسابات الجاية (المؤشر، المدى المتوقع) تبقى دقيقة
    let learnedCapL = null;
    const car = (data.cars || []).find((c) => c.id === carId);
    if (car && fuelRecord.isFull && !car.fuelCapL) {
      car.fuelCapL = fuelRecord.liters;
      car.fuelCapManual = true;
      learnedCapL = fuelRecord.liters;
    }
    if (car && fuelRecord.km && (!car.km || fuelRecord.km > car.km)) {
      car.km = fuelRecord.km;
    }

    await updateRow(clientDataTab, row._row, {
      DataJSON: JSON.stringify(data),
      UpdatedAt: new Date().toISOString(),
    });

    return { ok: true, fuelCapL: learnedCapL, record: newRecord };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getClientByPhone(phone) {
  const targetPhone = normalizePhone(phone);
  if (!targetPhone) return null;

  const [clientDataTab, licensesTab] = await Promise.all([ensureClientDataTab(), ensureLicensesTab()]);
  const [clientRows, licenseRows] = await Promise.all([readSheet(clientDataTab), readSheet(licensesTab)]);

  // تشخيص: يوضح بالظبط جوه Vercel Logs إيه اللي بيتقارن بإيه
  console.log("[getClientByPhone] البحث عن:", targetPhone,
    "| صفوف ClientData:", clientRows.length,
    "| صفوف Licenses:", licenseRows.length);
  console.log("[getClientByPhone] أكواد Licenses المتاحة:",
    licenseRows.map((l) => l.Code + ":" + (l.Phone || l.phone || "بدون رقم") + ":" + (l["Client Name"] || "بدون اسم")).join(" | "));

  // نجمع كل التطابقات الممكنة (مش نوقف عند أول واحد) — لأن نفس رقم
  // الواتساب ممكن يكون اتسجل غلط في أكتر من صف (زي صف تجريبي قديم +
  // الصف الحقيقي الحالي)، وكنا بنرجع أول واحد بترتيب القراءة بشكل عشوائي
  // فعليًا. دلوقتي بنختار أحدث صف اتحدّث (updatedAt) عشان نضمن دايمًا
  // إننا برجع أحدث بيانات حقيقية، مش أي صف قديم متبقي بالغلط.
  const allMatches = [];
  for (const row of clientRows) {
    if (!row.DataJSON) continue;
    let data;
    try {
      data = JSON.parse(row.DataJSON);
    } catch {
      continue; // صف تالف — نتخطاه بدل ما نكسر كل البحث
    }

    const cars = Array.isArray(data.cars) ? data.cars : [];
    // مطابقة دقيقة: الرقم كامل، أو آخر 9 أرقام على الأقل (يحل فرق 010 و2010)
    // بنشترط طول كافي عشان أرقام ناقصة/تالفة ما تعملش تطابق كاذب مع عميل تاني
    const tail = (x) => {
      const n = normalizePhone(x);
      return n.length >= 9 ? n.slice(-9) : "";
    };
    const targetTail = tail(targetPhone);
    const matchedCar = cars.find((c) => {
      const cand = [c.waPhone, c.ownerPhone].map(normalizePhone).filter((x) => x && x.length >= 9);
      return cand.some((cp) => cp === targetPhone || (targetTail && tail(cp) === targetTail));
    });
    if (matchedCar) {
      const updatedAt = row.UpdatedAt || data.updatedAt || matchedCar.updatedAt || "";
      allMatches.push({ row, data, cars, matchedCar, updatedAt });
    }
  }

  if (allMatches.length) {
    console.log(
      `[getClientByPhone] لقينا ${allMatches.length} تطابق للرقم ${targetPhone} — أكوادهم:`,
      allMatches.map((m) => `${m.row.Code} (owner: ${m.matchedCar.owner || "بدون"}, آخر تحديث: ${m.updatedAt || "غير معروف"})`).join(" | ")
    );
    // نختار الأحدث تحديثًا (لو التاريخ متاح)، وإلا آخر واحد في الترتيب
    // (أقرب للأحدث إحصائيًا من أول واحد لو مفيش تواريخ خالص)
    allMatches.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
    const best = allMatches[allMatches.length - 1];
    const { row, data, cars, matchedCar } = best;

    const resolvedName = resolveClientName(licenseRows, row.Code, targetPhone, matchedCar.owner);
    console.log(
      "[getClientByPhone] اخترنا Code:", row.Code,
      "| owner المخزن في العربية:", matchedCar.owner,
      "| الاسم النهائي بعد resolveClientName:", resolvedName
    );
    return {
      code: row.Code,
      // الاسم الرسمي من تاب Licenses أولاً (هو المصدر الموثوق)،
      // وبعدين اسم صاحب العربية نفسها — ولو مفيش نسيبه فاضي (مننفعش نخترع)
      name: resolvedName,
      phone: targetPhone,
      car: matchedCar,
      carId: matchedCar.id,
      allCars: cars,
      maintenance: (Array.isArray(data.maintenance) ? data.maintenance : []).filter(
        (m) => m.carId === matchedCar.id
      ),
      violations: (Array.isArray(data.violations) ? data.violations : []).filter(
        (v) => v.carId === matchedCar.id
      ),
      settings: data.settings || {},
      rawData: data,
      _row: row._row,
    };
  }

  // آخر محاولة: الرقم المسجل في الترخيص نفسه (عمود Phone في Licenses)
  const t9 = (x) => {
    const n = normalizePhone(x);
    return n.length >= 9 ? n.slice(-9) : "";
  };
  const targetT9 = t9(targetPhone);
  console.log("[getClientByPhone] مفيش تطابق في ClientData.cars — بندور في Licenses.Phone بذيل:", targetT9);
  const licMatch = licenseRows.find((l) => {
    const lp = normalizePhone(l.Phone || l.phone || "");
    if (!lp || lp.length < 9) return false;
    return lp === targetPhone || (targetT9 && t9(lp) === targetT9);
  });
  console.log("[getClientByPhone] نتيجة البحث في Licenses.Phone:", licMatch ? (licMatch.Code + " / " + licMatch["Client Name"]) : "مفيش تطابق خالص");
  if (licMatch) {
    const row = clientRows.find((r) => r.Code === licMatch.Code);
    if (row && row.DataJSON) {
      try {
        const data = JSON.parse(row.DataJSON);
        const cars2 = Array.isArray(data.cars) ? data.cars : [];
        const car = cars2.find((c) => c.id === data.activeCarId) || cars2[0];
        if (car) {
          return {
            code: row.Code,
            name: resolveClientName(licenseRows, licMatch.Code, targetPhone, car.owner),
            phone: targetPhone,
            car,
            carId: car.id,
            allCars: cars2,
            maintenance: (Array.isArray(data.maintenance) ? data.maintenance : []).filter((m) => m.carId === car.id),
            violations: (Array.isArray(data.violations) ? data.violations : []).filter((v) => v.carId === car.id),
            settings: data.settings || {},
            rawData: data,
            _row: row._row,
          };
        }
      } catch {}
    }
  }
  console.warn("getClientByPhone: مفيش تطابق للرقم", targetPhone, "— بندور في تاب Cars القديم كـ fallback أخير");

  // آخر محاولة خالص: تاب "Cars" القديم (بنية بيانات أقدم منفصلة عن ClientData JSON).
  // ده موجود عشان عملاء اتسجلوا وقت النظام القديم ولسه رقمهم مربوط هناك بس،
  // فبدل ما يوصلهم "مش مسجل" أو (الأخطر) نسيب Gemini يخترع بيانات بديلة،
  // بنجيب بياناتهم الحقيقية من هنا.
  try {
    const carsTab = process.env.SHEET_TAB_CARS || "Cars";
    // قراءة مباشرة من جوجل شيت (مش عن طريق readSheet العادية) — عشان نضمن
    // إننا شايفين أحدث بيانات فعلية في تاب Cars، من غير أي اعتماد على منطق
    // كاش/هجرة Supabase اللي ممكن يفشل بصمت لو التاب ده لسه ما اتقراش قبل كده.
    const carsRows = await googleReadSheet(carsTab);
    console.log(`[getClientByPhone] قرأنا ${carsRows.length} صف من تاب Cars مباشرة`);
    const t9car = (x) => {
      const n = normalizePhone(x);
      return n.length >= 9 ? n.slice(-9) : "";
    };
    const targetT9car = t9car(targetPhone);
    const carRow = carsRows.find((r) => {
      const rp = normalizePhone(r.waPhone || r.ownerPhone || "");
      return rp && rp.length >= 9 && (rp === targetPhone || (targetT9car && t9car(rp) === targetT9car));
    });
    if (carRow) {
      console.log("[getClientByPhone] اتلقى في تاب Cars القديم:", carRow.chatId, "| owner:", carRow.owner);
      const car = {
        id: carRow.chatId || "legacy",
        brand: carRow.brand || "",
        model: carRow.model || "",
        year: carRow.year || "",
        plate: carRow.plate || "",
        color: carRow.color || "",
        km: carRow.km || 0,
        carLicExp: carRow.carLicExp || "",
        drvLicExp: carRow.drvLicExp || "",
        insuranceExp: carRow.insuranceExp || "",
        owner: carRow.owner || "",
        waPhone: carRow.waPhone || "",
      };
      return {
        code: carRow.chatId || "",
        name: resolveClientName(licenseRows, "", targetPhone, car.owner),
        phone: targetPhone,
        car,
        carId: car.id,
        allCars: [car],
        maintenance: [],
        violations: [],
        settings: {},
        rawData: { cars: [car], maintenance: [], violations: [] },
        _row: carRow._row,
        _legacySource: "Cars",
      };
    }
  } catch (e) {
    console.warn("getClientByPhone: تعذر قراءة تاب Cars القديم:", e.message);
  }

  // آخر محاولة: العميل ده كان مؤرشف (خمول 30 يوم) وبيرجع دلوقتي. بندور في
  // تاب Archive، ولو لقيناه، نرجّعه تلقائيًا لـ ClientData بكل بياناته
  // القديمة (صيانات، عربيات، كل حاجة) — عشان يكمل من حيث وقف، مش يبدأ
  // تسجيل من الصفر. ده بيحصل تلقائيًا من غير أي تدخل يدوي من الأدمن.
  try {
    const restored = await tryRestoreFromArchive_(targetPhone, licenseRows);
    if (restored) return restored;
  } catch (e) {
    console.warn("getClientByPhone: فشل فحص/استرجاع الأرشيف:", e.message);
  }

  return null; // الرقم مش مسجل عند أي عميل في أي مصدر
}

/**
 * يرجّع كل العربيات اللي عندها رقم واتساب مسجل (waPhone) وعميلها مفعّل رسالة
 * الصباح (D.settings.morningMessageEnabled !== false — افتراضيًا مفعّلة لو
 * العميل ربط رقمه أصلاً، إلا لو قفلها بنفسه من صفحة إعداداته).
 * كل "عنصر" هنا معاه client-shaped object زي اللي getClientByPhone بيرجّعه،
 * عشان نقدر نستخدم نفس getCarStatus/getLicenseStatus/getViolationsStatus عليه.
 */
export async function getAllOptedInClients() {
  const [clientDataTab, licensesTab] = await Promise.all([ensureClientDataTab(), ensureLicensesTab()]);
  const [clientRows, licenseRows] = await Promise.all([readSheet(clientDataTab), readSheet(licensesTab)]);

  const result = [];

  for (const row of clientRows) {
    if (!row.DataJSON) continue;
    let data;
    try {
      data = JSON.parse(row.DataJSON);
    } catch {
      continue;
    }

    const cars = Array.isArray(data.cars) ? data.cars : [];
    const morningEnabled = data.settings?.morningMessageEnabled !== false; // افتراضي: مفعّل

    if (!morningEnabled) continue;

    const license = licenseRows.find((l) => l.Code === row.Code);

    for (const car of cars) {
      if (!car.waPhone) continue; // العربية دي مش مربوطة بواتساب
      result.push({
        code: row.Code,
        name: resolveClientName(licenseRows, row.Code, car.waPhone, car.owner),
        phone: car.waPhone,
        car,
        carId: car.id,
        allCars: cars,
        maintenance: (Array.isArray(data.maintenance) ? data.maintenance : []).filter((m) => m.carId === car.id),
        violations: (Array.isArray(data.violations) ? data.violations : []).filter((v) => v.carId === car.id),
        settings: data.settings || {},
        rawData: data,
        _row: row._row,
      });
    }
  }

  return result;
}

/**
 * حالة العربية: الزيت، الكاوتش، آخر صيانة، الكيلومتر الحالي.
 * بيحسب "متبقي" بنفس منطق getMaintStatus في الواجهة (kmLeft/daysLeft).
 */
export function getCarStatus(client) {
  if (!client || !client.car) return null;
  const car = client.car;
  const km = Number(car.km) || 0;
  const now = new Date();

  function statusFor(type) {
    const rec = (client.maintenance || [])
      .filter((m) => m.type === type)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0]; // آخر مرة اتعمل فيها الصيانة دي
    const meta = MAINT_DB[type] || { name: type, kmInt: 0, monInt: 0 };
    if (!rec) {
      return { type, name: meta.name, lastDate: null, lastKm: null, status: "unknown", statusText: "لا يوجد سجل" };
    }
    const daysSince = Math.floor((now - new Date(rec.date)) / 86400000);
    const kmSince = km - (rec.km || 0);
    const kmInt = rec.kmInt || meta.kmInt || 0;
    const monInt = rec.monInt || meta.monInt || 0;
    const kmLeft = kmInt ? kmInt - kmSince : Infinity;
    const daysLeft = monInt ? monInt * 30 - daysSince : Infinity;

    let status = "ok";
    let statusText = "كويس ✅";
    if (kmLeft <= 0 || daysLeft <= 0) {
      status = "danger";
      statusText = "متأخر! ⚠️";
    } else if (kmLeft <= 500 || daysLeft <= 30) {
      status = "warn";
      statusText = kmLeft <= 500 ? `باقي ${Math.round(kmLeft)} كم` : `باقي ${Math.round(daysLeft)} يوم`;
    }

    return {
      type,
      name: meta.name,
      lastDate: rec.date,
      lastKm: rec.km,
      kmLeft: Number.isFinite(kmLeft) ? Math.round(kmLeft) : null,
      daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft) : null,
      status,
      statusText,
    };
  }

  return {
    brand: car.brand || "",
    model: car.model || "",
    year: car.year || "",
    km,
    kmUpdatedAt: car.kmUpdatedAt || null,
    oil: statusFor("oil"),
    tires: statusFor("tires"),
    allStatuses: Object.keys(MAINT_DB).map(statusFor),
  };
}

/** أقرب صيانة جاية (الأقل كيلومتر أو يوم متبقي) — يفيد في زر "مواعيد أقرب صيانات". */
export function getNextService(client) {
  const status = getCarStatus(client);
  if (!status) return null;
  const upcoming = status.allStatuses
    .filter((s) => s.kmLeft !== null || s.daysLeft !== null)
    .sort((a, b) => {
      const aVal = Math.min(a.kmLeft ?? Infinity, (a.daysLeft ?? Infinity) * 30); // تقريب: نقارن بوحدة كم تقريبية
      const bVal = Math.min(b.kmLeft ?? Infinity, (b.daysLeft ?? Infinity) * 30);
      return aVal - bVal;
    });
  return upcoming[0] || null;
}

/**
 * حالة الرخصة: تاريخ انتهاء رخصة السيارة (car.carLicExp) وكام يوم فاضل.
 * (مش من تاب "Licenses" — ده تاب أكواد تفعيل البرنامج، مختلف تمامًا).
 */
export function getLicenseStatus(client) {
  if (!client || !client.car) return null;
  const car = client.car;
  const expDate = car.carLicExp ? new Date(car.carLicExp) : null;
  if (!expDate || isNaN(expDate.getTime())) {
    return { hasDate: false, expiryDate: null, daysLeft: null, status: "unknown", statusText: "لا يوجد تاريخ مسجل" };
  }
  const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
  let status = "ok";
  let statusText = `فاضل ${daysLeft} يوم ✅`;
  if (daysLeft <= 0) {
    status = "danger";
    statusText = `الرخصة منتهية من ${Math.abs(daysLeft)} يوم 🚨`;
  } else if (daysLeft <= 30) {
    status = "warn";
    statusText = `فاضل ${daysLeft} يوم بس ⚠️`;
  }
  return { hasDate: true, expiryDate: car.carLicExp, daysLeft, status, statusText };
}

/** المخالفات غير المدفوعة بتاعة العربية. */
export function getViolationsStatus(client) {
  if (!client) return { count: 0, unpaid: [], total: [] };
  const all = client.violations || [];
  const unpaid = all.filter((v) => !v.paid);
  return { count: unpaid.length, unpaid, total: all };
}

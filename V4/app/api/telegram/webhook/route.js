import { NextResponse } from "next/server";
import { readSheet, updateRow } from "@/lib/googleSheets";
import {
  getClientByPhone,
  getCarStatus,
  getLicenseStatus,
  getNextService,
  getViolationsStatus,
  updateClientNameInLicenses,
  saveFuelRecordToClientData,
  linkTelegramChatToCode,
  resolveWaPhoneFromTelegramChatId,
  hasValidTelegramLicense,
} from "@/lib/google-sheets";
import { sendTelegramMessage, sendTelegramMainMenu, sendTelegramWelcome, mainKeyboard } from "@/lib/telegram";
import { logMessage, setPendingAction, saveOdometerToSheet } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// -----------------------------------------------------------------------------
// نفس فلسفة webhook الواتساب: مصدر الحقيقة الوحيد لبيانات العميل هو
// ClientData، وربط chatId (تليجرام) بالعميل بيتم عن طريق تاب Users (بنفس
// الكود اللي كان الأسكربت بيستخدمه) — شوف lib/google-sheets.js للتفاصيل.
//
// ده كان بديل عن Google Apps Script (اللي كان بيعالج رسايل تليجرام قبل
// كده). الأسكربت لسه ممكن يفضل موجود للرسايل اللي وصلت أثناء الانتقال، لكن
// المصدر الرسمي الجديد لتليجرام هو هنا.
// -----------------------------------------------------------------------------

// أي طلب GET بيرجع تأكيد إن الراوت شغال (زيارة عادية للرابط)
export async function GET() {
  return NextResponse.json({ ok: true, message: "IDEA CarHub 360 Telegram webhook is running." });
}

export async function POST(req) {
  console.log("[telegram webhook] === طلب POST جديد وصل ===");
  try {
    const update = await req.json();
    console.log("[telegram webhook] الـ body اتقرا صح:", JSON.stringify(update).slice(0, 300));
    const msg = update.message;
    if (!msg || !msg.text) {
      console.log("[telegram webhook] مفيش message.text — نتجاهل (ده طبيعي لو edited_message أو callback_query)");
      return NextResponse.json({ ok: true, ignored: true });
    }

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    console.log("[telegram webhook] chatId:", chatId, "| text:", text);

    // ─── /start CODE أو /start لوحدها: ربط الحساب ───
    if (text.indexOf("/start") === 0) {
      console.log("[telegram webhook] بيعالج /start...");
      await handleStart(chatId, text);
      console.log("[telegram webhook] /start اتعالج بنجاح");
      return NextResponse.json({ ok: true });
    }

    if (text === "إلغاء" || text === "الغاء" || text === "/cancel") {
      await sendTelegramMessage(chatId, "✅ تم الإلغاء. اختار من القايمة تحت 👇", mainKeyboard());
      return NextResponse.json({ ok: true });
    }

    // ─── بوابة صلاحية الترخيص: لو الحساب اتمسح من Licenses، منكملش ───
    console.log("[telegram webhook] بيفحص صلاحية الترخيص...");
    const validLicense = await hasValidTelegramLicense(chatId).catch((e) => {
      console.error("[telegram webhook] hasValidTelegramLicense رمت استثناء:", e.message);
      return true;
    });
    console.log("[telegram webhook] نتيجة فحص الترخيص:", validLicense);
    if (!validLicense) {
      await sendTelegramMessage(
        chatId,
        "⚠️ حسابك مش مفعّل حاليًا في IDEA CarHub 360°.\nلو ده غلط، تواصل مع فريق الدعم، أو لو عندك كود اشتراك جديد ابعته بالشكل ده:\n/start الكود_بتاعك"
      );
      return NextResponse.json({ ok: true });
    }

    // ─── جيب بيانات العميل عن طريق رقم الواتساب المرتبط بالـ chatId ده ───
    console.log("[telegram webhook] بيدور على waPhone المرتبط بـ chatId:", chatId);
    const waPhone = await resolveWaPhoneFromTelegramChatId(chatId);
    console.log("[telegram webhook] waPhone المُلاقى:", waPhone);
    if (!waPhone) {
      await sendTelegramMessage(
        chatId,
        "👋 أهلاً بيك في IDEA CarHub 360°!\n\nحسابك مش مربوط لسه.\nافتح تطبيق IDEA CarHub 360°، من الإعدادات انسخ كود الربط، وابعته هنا كده:\n/start الكود_بتاعك"
      );
      return NextResponse.json({ ok: true });
    }

    console.log("[telegram webhook] بيجيب بيانات العميل من waPhone:", waPhone);
    const client = await getClientByPhone(waPhone);
    console.log("[telegram webhook] client اتلاقى؟", !!client, client ? ("code: " + client.code) : "");
    if (!client) {
      await sendTelegramMessage(
        chatId,
        "⚠️ تعذر إيجاد بيانات عربيتك حاليًا. كلم فريق الدعم من فضلك."
      );
      return NextResponse.json({ ok: true });
    }

    await logMessage({
      phone: waPhone,
      clientCode: client.code,
      clientName: client.name,
      direction: "in",
      messageType: "telegram_text",
      content: text,
      raw: msg,
    });

    console.log("[telegram webhook] بيمرر لـ routeIncomingMessage...");
    try {
      await routeIncomingMessage(client, chatId, text);
    } catch (routeErr) {
      console.error("telegram routeIncomingMessage error:", routeErr.message, routeErr.stack);
      try {
        await sendTelegramMainMenu(chatId, client);
      } catch {}
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[telegram webhook] === خطأ عام غير متوقع ===");
    console.error("telegram webhook POST error:", e.message);
    console.error("Stack trace:", e.stack);
    // برضه نرجّع 200 لتليجرام عشان متعملش retry storm، لكن نسجل الخطأ في اللوج
    return NextResponse.json({ ok: false, error: e.message }, { status: 200 });
  }
}

// -----------------------------------------------------------------------------
// /start CODE — ربط حساب تليجرام بكود الترخيص
// -----------------------------------------------------------------------------
async function handleStart(chatId, text) {
  const parts = text.split(" ");
  const code = parts.length > 1 ? parts[1].trim() : "";

  if (!code) {
    await sendTelegramMessage(
      chatId,
      "👋 أهلاً بيك في IDEA CarHub 360°!\n\n🚗 نظام متابعة عربيتك من ايديا EG\n\nعشان تربط حسابك بالتطبيق، افتح صفحة الإعدادات في التطبيق وانسخ كود الربط، وابعته هنا كده:\n/start الكود_بتاعك"
    );
    return;
  }

  const result = await linkTelegramChatToCode(chatId, code);
  if (!result.ok) {
    await sendTelegramMessage(
      chatId,
      "⚠️ الكود ده مش موجود عندنا.\nتأكد إنه نفس الكود اللي في التطبيق، أو كلم الدعم."
    );
    return;
  }

  if (!result.waPhone) {
    await sendTelegramMessage(
      chatId,
      `✅ تم الربط بنجاح!\n\nبس لازم تسجّل رقم الواتساب بتاعك في التطبيق (الإعدادات > الربط بالبوتات) عشان نقدر نجيبلك بيانات عربيتك هنا كمان.`
    );
    return;
  }

  const client = await getClientByPhone(result.waPhone);
  if (client) {
    await sendTelegramWelcome(chatId, client);
  } else {
    await sendTelegramMessage(chatId, "✅ تم الربط بنجاح!", mainKeyboard());
  }
}

// -----------------------------------------------------------------------------
// توجيه الرسالة الواردة — نفس منطق الواتساب، لكن كل ردّ بيتبعت عن طريق
// sendTelegramMessage بدل sendTextMessage
// -----------------------------------------------------------------------------
async function routeIncomingMessage(client, chatId, text) {
  // أمر تصحيح الاسم
  const nameCmdMatch = text.match(/^(?:اسمي|أسمي|تصحيح الاسم)\s+(.{2,60})$/u);
  if (nameCmdMatch) {
    const newName = nameCmdMatch[1].trim();
    const ok = await updateClientNameInLicenses(client.code, newName);
    await sendTelegramMessage(
      chatId,
      ok
        ? `✅ تم تحديث اسمك لـ "${newName}" بنجاح.\nهيظهر الاسم الجديد في كل الرسايل الجاية.`
        : "⚠️ تعذر تحديث الاسم، جرب تاني أو كلم الدعم."
    );
    return;
  }

  // طلب صريح للقايمة
  const menuKeywords = /^(قائمة|قايمة|القائمة|القايمة|menu|list|ابدأ|إبدأ|هاي|هلا|السلام عليكم|مرحبا|أهلا|اهلا)$/iu;
  if (menuKeywords.test(text)) {
    await sendTelegramMainMenu(chatId, client);
    return;
  }

  // لو إحنا مستنيين قراءة عداد
  if (client.car.waPendingAction === "odometer") {
    await handleOdometerReply(client, chatId, text);
    return;
  }

  // fuel flow state machine (نفس آلية الواتساب، بمفتاح منفصل عشان
  // منلخبطش حالة تليجرام مع حالة واتساب لنفس الشخص لو الاتنين مربوطين)
  if (typeof global._telegramFuelState === "undefined") global._telegramFuelState = {};
  const fuelSt = global._telegramFuelState[chatId];
  if (fuelSt) {
    const handled = await handleFuelFlow(client, chatId, text, fuelSt);
    if (handled) return;
  }

  // أزرار القايمة الرئيسية (نص الزرار نفسه بيوصل كرسالة نصية عادية في تليجرام)
  const menuAction = matchMenuButton(text);
  if (menuAction) {
    await handleMenuSelection(client, chatId, menuAction);
    return;
  }

  // رقم 3-7 خانات = قراءة عداد مباشرة
  if (/^\d{3,7}$/.test(text)) {
    await handleOdometerReply(client, chatId, text);
    return;
  }

  // أي كلام تاني -> رسالة افتراضية آمنة (بدون Gemini هنا حاليًا، تجنبًا
  // لتكرار كود التخمين بين القناتين؛ ممكن نضيفه لاحقًا لو حبيت)
  await sendTelegramMessage(
    chatId,
    "وصلتني رسالتك 👌 ابعت \"قايمة\" تشوف كل الأوامر، أو اختار من تحت.",
    mainKeyboard()
  );
}

// بيربط نص زرار الـReply Keyboard بنفس الـ id المستخدم في menu الواتساب
function matchMenuButton(text) {
  const map = {
    "📊 حالة العربية": "menu_car_status",
    "🪪 بيانات الرخصة": "menu_license_status",
    "⛽ تسجيل تفويلة": "menu_fuel_log",
    "📍 تسجيل عداد": "menu_odometer",
    "🔧 أقرب صيانات": "menu_next_service",
    "🚦 المخالفات": "menu_violations",
    "📊 التقرير الكامل": "menu_full_report",
    "📞 الأرقام الهامة": "menu_important_numbers",
  };
  return map[text] || null;
}

async function handleMenuSelection(client, chatId, action) {
  switch (action) {
    case "menu_car_status": {
      const status = getCarStatus(client);
      if (!status) {
        await sendTelegramMessage(chatId, "معلش، مش لاقيين بيانات عربيتك دلوقتي. كلم الدعم من فضلك.");
        break;
      }
      const lines = [
        `🚗 ${status.brand} ${status.model} ${status.year}`,
        `الكيلومتراج الحالي: ${status.km.toLocaleString("ar-EG")} كم`,
        ``,
        `🛢️ زيت الموتور: ${status.oil.statusText}`,
        status.oil.lastDate ? `   آخر تغيير: ${status.oil.lastDate} عند ${status.oil.lastKm ?? "--"} كم` : "",
        ``,
        `🔵 الكاوتش: ${status.tires.statusText}`,
        status.tires.lastDate ? `   آخر تغيير: ${status.tires.lastDate} عند ${status.tires.lastKm ?? "--"} كم` : "",
      ].filter(Boolean);
      await sendTelegramMessage(chatId, lines.join("\n"));
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    case "menu_license_status": {
      const lic = getLicenseStatus(client);
      if (!lic || !lic.hasDate) {
        await sendTelegramMessage(chatId, "مفيش تاريخ انتهاء رخصة مسجل لعربيتك. تقدر تضيفه من التطبيق.");
      } else {
        await sendTelegramMessage(chatId, `📋 رخصة السيارة:\nتاريخ الانتهاء: ${lic.expiryDate}\n${lic.statusText}`);
      }
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    case "menu_next_service": {
      const next = getNextService(client);
      if (!next) {
        await sendTelegramMessage(chatId, "مفيش سجل صيانات كفاية عشان نحسبلك الصيانة الجاية. سجل الصيانات من التطبيق الأول.");
      } else {
        const kmTxt = next.kmLeft !== null ? `${next.kmLeft} كم` : "غير محدد";
        const daysTxt = next.daysLeft !== null ? `${next.daysLeft} يوم` : "غير محدد";
        await sendTelegramMessage(
          chatId,
          `🔧 أقرب صيانة جاية: ${next.name}\nمتبقي: ${kmTxt} أو ${daysTxt} (الأقرب)\nالحالة: ${next.statusText}`
        );
      }
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    case "menu_violations": {
      const v = getViolationsStatus(client);
      if (!v.count) {
        await sendTelegramMessage(chatId, "🎉 مفيش مخالفات غير مدفوعة على عربيتك دلوقتي.");
      } else {
        const lines = v.unpaid.slice(0, 5).map((x) => `• ${x.type} — ${x.amount} جنيه (بتاريخ ${x.date})`).join("\n");
        await sendTelegramMessage(chatId, `🚨 عندك ${v.count} مخالفة غير مدفوعة:\n${lines}`);
      }
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    case "menu_odometer": {
      await setPendingAction(client.code, client.carId, "odometer");
      await sendTelegramMessage(chatId, "📊 اكتب قراءة العداد الحالية (بالكيلومتر) وابعتها رقم بس، مثال: 45230");
      break;
    }

    case "menu_fuel_log": {
      await sendTelegramMessage(chatId, "⛽ تسجيل تفويلة:\n\n1️⃣ قولت (ملأ التانك كامل)\n2️⃣ عدد لترات معين\n\nابعت 1 أو 2");
      if (typeof global._telegramFuelState === "undefined") global._telegramFuelState = {};
      global._telegramFuelState[chatId] = { step: "choose_type" };
      break;
    }

    case "menu_full_report": {
      const fullStatus = getCarStatus(client);
      if (!fullStatus) {
        await sendTelegramMessage(chatId, "مفيش بيانات كافية للتقرير دلوقتي.");
        break;
      }
      const repLines = [
        `📊 التقرير الكامل — ${fullStatus.brand} ${fullStatus.model}`,
        `📟 العداد: ${fullStatus.km.toLocaleString()} كم`, ``,
        `🛢️ الزيت: ${fullStatus.oil.statusText}`,
        `🔵 الكاوتش: ${fullStatus.tires.statusText}`,
        `🔧 أقرب صيانة: ${fullStatus.nextService ? fullStatus.nextService.name + " — باقي " + fullStatus.nextService.kmLeft.toLocaleString() + " كم" : "مفيش سجلات"}`,
        (client.violations || []).filter((v) => !v.paid).length
          ? `🚨 مخالفات غير مدفوعة: ${(client.violations || []).filter((v) => !v.paid).length}`
          : `✅ مفيش مخالفات`,
      ].filter(Boolean);
      await sendTelegramMessage(chatId, repLines.join("\n"));
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    case "menu_important_numbers": {
      let txt = "📞 الأرقام الهامة\n";
      try {
        const adminRows = await readSheet("AdminNumbers");
        const fixed = adminRows.filter((r) => r.Name && r.Phone);
        if (fixed.length) {
          txt += "\n📌 من الإدارة:\n";
          fixed.forEach((r) => { txt += `• ${r.Name}: ${r.Phone}${r.Address ? " — " + r.Address : ""}\n`; });
        }
      } catch (e) {}
      const myContacts = client.rawData && Array.isArray(client.rawData.contacts) ? client.rawData.contacts : [];
      if (myContacts.length) {
        txt += "\n👤 أرقامك المحفوظة:\n";
        myContacts.slice(0, 15).forEach((c) => { txt += `• ${c.name || "بدون اسم"}: ${c.phone || ""}\n`; });
      }
      if (!txt.includes("•")) txt += "\nمفيش أرقام محفوظة لسه — ضيفها من التطبيق صفحة أرقام هامة.";
      await sendTelegramMessage(chatId, txt.trim());
      await sendTelegramMainMenu(chatId, client);
      break;
    }

    default:
      await sendTelegramMainMenu(chatId, client);
  }
}

async function handleFuelFlow(client, chatId, text, fuelSt) {
  if (fuelSt.step === "choose_type") {
    if (text === "1") {
      global._telegramFuelState[chatId] = { step: "ask_km", full: true };
      await sendTelegramMessage(chatId, "✅ قولت!\n📊 ابعتلي قراءة العداد دلوقتي (الرقم بس، مثال: 85500)");
    } else if (text === "2") {
      global._telegramFuelState[chatId] = { step: "ask_liters", full: false };
      await sendTelegramMessage(chatId, "⛽ كام لتر حطيت؟ (الرقم بس، مثال: 35)");
    } else {
      await sendTelegramMessage(chatId, "ابعت 1 أو 2 بس 🙏");
    }
    return true;
  }
  if (fuelSt.step === "ask_liters") {
    const liters = parseFloat(text);
    if (!liters || liters < 1) {
      await sendTelegramMessage(chatId, "ابعت عدد اللترات بالأرقام (مثال: 35)");
      return true;
    }
    global._telegramFuelState[chatId] = { ...fuelSt, step: "ask_km", liters };
    await sendTelegramMessage(chatId, "📊 ابعتلي قراءة العداد دلوقتي (مثال: 85500)");
    return true;
  }
  if (fuelSt.step === "ask_km") {
    const km = parseInt(text);
    if (!km || km < 100) {
      await sendTelegramMessage(chatId, "ابعت قراءة العداد بالأرقام (مثال: 85500)");
      return true;
    }

    const knownCapL = Number(client.car?.fuelCapL) || null;
    const liters = fuelSt.full ? knownCapL || 45 : fuelSt.liters || 0;
    const fuelPrice = client.car?.fuelPrice || 13.75;
    const cost = (liters * fuelPrice).toFixed(2);
    const prevKm = Number(client.car?.km) || 0;
    const dist = prevKm > 0 && km > prevKm ? km - prevKm : null;
    const avg = dist && liters > 0 ? dist / liters : null;
    const rangeKmPerL = avg || 12;

    const saveResult = await saveFuelRecordToClientData(client.code, client.carId, {
      date: new Date().toISOString().slice(0, 10),
      km, liters, pricePerL: fuelPrice, isFull: fuelSt.full, station: "",
    });
    if (!saveResult.ok) console.warn("saveFuelRecordToClientData (telegram) failed:", saveResult.error);

    let reply = "✅ اتسجلت التفويلة:\n";
    reply += fuelSt.full ? "⛽ قولت (كامل)\n" : `⛽ ${liters} لتر\n`;
    reply += `💰 التكلفة: ${cost} ج (${fuelPrice} ج/لتر)\n`;
    reply += `📟 العداد: ${km.toLocaleString()} كم\n`;
    if (dist) reply += `📏 المسافة: ${dist.toLocaleString()} كم\n`;
    if (avg) reply += `🔥 المعدل: ${avg.toFixed(1)} كم/لتر\n`;
    reply += `⛽ المتوقع يمشي: ~${Math.round(liters * rangeKmPerL)} كم\n🙏 ربنا يوصلك بالأمان!`;
    delete global._telegramFuelState[chatId];
    await handleOdometerReply(client, chatId, String(km), { silent: true });
    await sendTelegramMessage(chatId, reply);
    await sendTelegramMainMenu(chatId, client);
    return true;
  }
  return false;
}

async function handleOdometerReply(client, chatId, text, opts = {}) {
  const digitsOnly = text.replace(/[^\d]/g, "");
  if (!digitsOnly) {
    if (!opts.silent) await sendTelegramMessage(chatId, "من فضلك اكتب رقم قراءة العداد بس (مثال: 45230).");
    return;
  }

  const result = await saveOdometerToSheet(client, digitsOnly);
  if (!result.ok) {
    if (!opts.silent) await sendTelegramMessage(chatId, `⚠️ ${result.error}`);
    return;
  }

  if (opts.silent) return; // اتنادت من جوه fuel flow، الرد النهائي هيتبعت من هناك
  await sendTelegramMessage(
    chatId,
    `✅ تم تحديث قراءة العداد لـ ${result.km.toLocaleString("ar-EG")} كم لعربية ${result.carBrand} ${result.carModel}.`
  );
  await sendTelegramMainMenu(chatId, client);
}

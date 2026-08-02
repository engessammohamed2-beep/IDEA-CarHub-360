import { NextResponse } from "next/server";
import { readSheet } from "@/lib/googleSheets";
import { geminiGenerate } from "@/lib/aiSettings";
import { getClientByPhone, getCarStatus, getLicenseStatus, getNextService, getViolationsStatus, updateClientNameInLicenses, saveFuelRecordToClientData } from "@/lib/google-sheets";
import { sendTextMessage, sendInteractiveList, saveOdometerToSheet, setPendingAction, logMessage } from "@/lib/whatsapp";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET -> Meta webhook verification handshake
// -----------------------------------------------------------------------------
// Meta بتبعت GET مرة واحدة وقت ما تحط رابط الـ webhook في App Dashboard، فيها
// hub.mode / hub.verify_token / hub.challenge. لازم نتأكد إن hub.verify_token
// مطابق لـ WEBHOOK_VERIFY_TOKEN اللي عندنا، وبعدين نرجّع hub.challenge كـ نص
// عادي (مش JSON) عشان Meta تعتبر الـ webhook متحقق منه.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token && expectedToken && token === expectedToken) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "فشل التحقق من الـ webhook" }, { status: 403 });
}

// -----------------------------------------------------------------------------
// POST -> استقبال الرسايل / ضغطات الأزرار / قرايات العداد من العميل
// -----------------------------------------------------------------------------
export async function POST(req) {
  try {
    const body = await req.json();

    // شكل الـ payload القياسي من Meta:
    // entry[0].changes[0].value.messages[0]  (لو فيه رسالة فعلاً؛ ممكن يجي statuses بس)
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || !messages.length) {
      // ده غالبًا إشعار حالة تسليم (delivered/read) مش رسالة فعلية — نتجاهله بهدوء.
      return NextResponse.json({ ok: true, ignored: true });
    }

    const message = messages[0];
    const from = message.from; // رقم واتساب العميل (دولي، بدون +)

    // نجيب بيانات العميل من رقمه — لو مش موجود، نرد برسالة واضحة ونوقف هنا
    // (Error Handling الأساسي المطلوب: العميل مش متسجل في الشيت).
    const client = await getClientByPhone(from);

    if (!client) {
      await logMessage({
        phone: from,
        direction: "in",
        messageType: message.type,
        content: extractMessageText(message),
        raw: message,
      });
      await sendTextMessage(
        from,
        "أهلاً بيك 👋\nرقمك مش مسجل عندنا كرقم واتساب مرتبط بأي عربية.\nكلم فريق الدعم أو من داخل تطبيق IDEA CarHub 360 اربط رقمك من صفحة (الإعدادات > الربط بالبوتات)."
      );
      return NextResponse.json({ ok: true, unregistered: true });
    }

    // نسجل الرسالة الواردة في اللوج (تظهر live في /client/dashboard/whatsapp-messages)
    await logMessage({
      phone: from,
      clientCode: client.code,
      clientName: client.name,
      direction: "in",
      messageType: message.type,
      content: extractMessageText(message),
      raw: message,
    });

    try {
      await routeIncomingMessage(client, message);
    } catch (routeErr) {
      console.error("routeIncomingMessage error:", routeErr.message, routeErr.stack);
      // حتى لو حصل خطأ برمجي جوه معالجة الرسالة، العميل لازم ياخد رد —
      // مش يفضل ساكت وكأن البوت واقف تمامًا (ده كان بيحصل قبل الإصلاح ده).
      try {
        await sendMainMenu(client);
      } catch {}
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("whatsapp webhook POST error:", e.message);
    // برضه نرجّع 200 لـ Meta عشان متعملش retry storm، لكن نسجل الخطأ في اللوج
    return NextResponse.json({ ok: false, error: e.message }, { status: 200 });
  }
}

function extractMessageText(message) {
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "interactive") {
    return (
      message.interactive?.list_reply?.title ||
      message.interactive?.button_reply?.title ||
      JSON.stringify(message.interactive)
    );
  }
  if (message.type === "button") return message.button?.text || "";
  return `[${message.type}]`;
}

// -----------------------------------------------------------------------------
// توجيه الرسالة الواردة: هل هي اختيار من القايمة؟ هل هي رد على "اكتب قراءة العداد"؟
// هل هي رسالة عامة (نرد عليها بالقايمة الرئيسية)؟
// -----------------------------------------------------------------------------
async function routeIncomingMessage(client, message) {
  const from = message.from;

  // (أ) العميل ضغط على عنصر من القايمة التفاعلية
  if (message.type === "interactive" && message.interactive?.type === "list_reply") {
    const selectedId = message.interactive.list_reply.id;
    await handleMenuSelection(client, selectedId);
    return;
  }

  // (ب) العميل ضغط على زرار سريع (زي [سجل قراءة العداد] [تفاصيل أكتر] في رسالة الصباح)
  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const selectedId = message.interactive.button_reply.id;
    await handleMenuSelection(client, selectedId);
    return;
  }

  // (ج) العميل بعت نص عادي
  if (message.type === "text") {
    const text = (message.text?.body || "").trim();

    // أمر تصحيح الاسم: "اسمي فلان الفلاني" — بيحدّث Client Name في Licenses مباشرة.
    // ده حل نهائي لمشكلة ظهور اسم قديم/غلط بغض النظر عن سببها (بيانات ناقصة،
    // عدم تطابق، إلخ) — العميل نفسه بيصحّح اسمه من الواتساب فورًا.
    const nameCmdMatch = text.match(/^(?:اسمي|أسمي|تصحيح الاسم)\s+(.{2,60})$/u);
    if (nameCmdMatch) {
      const newName = nameCmdMatch[1].trim();
      const ok = await updateClientNameInLicenses(client.code, newName);
      await sendTextMessage(
        client.phone,
        ok
          ? `✅ تم تحديث اسمك لـ "${newName}" بنجاح.\nهيظهر الاسم الجديد في كل الرسايل الجاية.`
          : "⚠️ تعذر تحديث الاسم، جرب تاني أو كلم الدعم."
      );
      return;
    }

    // طلب صريح لعرض القايمة (بأي صيغة) — لازم يفتح القايمة على طول، مش يعدي
    // على المساعد الذكي (Gemini). ده أهم مسار في البوت وميستحملش أي التباس.
    const menuKeywords = /^(قائمة|قايمة|القائمة|القايمة|menu|list|ابدأ|إبدأ|start|هاي|هلا|السلام عليكم|مرحبا|أهلا|اهلا)$/iu;
    if (menuKeywords.test(text)) {
      await sendMainMenu(client);
      return;
    }

    // لو إحنا مستنيين منه قراءة عداد (اختار "سجل قراءة العداد" قبل كده)
    if (client.car.waPendingAction === "odometer") {
      await handleOdometerReply(client, text);
      return;
    }

    // fuel flow state machine
    if (typeof global._fuelState === "undefined") global._fuelState = {};
    const fuelSt = global._fuelState[client.phone];
    if (fuelSt) {
      if (fuelSt.step === "choose_type") {
        if (text === "1") {
          global._fuelState[client.phone] = { step: "ask_km", full: true };
          await sendTextMessage(client.phone, "✅ قولت!\n📊 ابعتلي قراءة العداد دلوقتي (الرقم بس، مثال: 85500)");
        } else if (text === "2") {
          global._fuelState[client.phone] = { step: "ask_liters", full: false };
          await sendTextMessage(client.phone, "⛽ كام لتر حطيت؟ (الرقم بس، مثال: 35)");
        } else {
          await sendTextMessage(client.phone, "ابعت 1 أو 2 بس 🙏");
        }
        return;
      }
      if (fuelSt.step === "ask_liters") {
        const liters = parseFloat(text);
        if (!liters || liters < 1) { await sendTextMessage(client.phone, "ابعت عدد اللترات بالأرقام (مثال: 35)"); return; }
        global._fuelState[client.phone] = { ...fuelSt, step: "ask_km", liters };
        await sendTextMessage(client.phone, "📊 ابعتلي قراءة العداد دلوقتي (مثال: 85500)");
        return;
      }
      if (fuelSt.step === "ask_km") {
        const km = parseInt(text);
        if (!km || km < 100) { await sendTextMessage(client.phone, "ابعت قراءة العداد بالأرقام (مثال: 85500)"); return; }

        // سعة التانك الحقيقية بتاعة العربية دي لو متسجلة، مش رقم ثابت 60 لتر
        const knownCapL = Number(client.car?.fuelCapL) || null;
        const liters = fuelSt.full ? (knownCapL || 45) : (fuelSt.liters || 0);
        const fuelPrice = client.car?.fuelPrice || 13.75;
        const cost = (liters * fuelPrice).toFixed(2);
        const prevKm = Number(client.car?.km) || 0;
        const dist = prevKm > 0 && km > prevKm ? km - prevKm : null;
        const avg = dist && liters > 0 ? dist / liters : null;
        const rangeKmPerL = avg || 12; // افتراضي بس لو أول تفويلة خالص ومفيش تاريخ

        // ─── الحفظ الفعلي في ClientData (ده كان ناقص خالص قبل كده) ───
        const saveResult = await saveFuelRecordToClientData(client.code, client.carId, {
          date: new Date().toISOString().slice(0, 10),
          km,
          liters,
          pricePerL: fuelPrice,
          isFull: fuelSt.full,
          station: "",
        });
        if (!saveResult.ok) {
          console.warn("saveFuelRecordToClientData failed:", saveResult.error);
        }

        let reply = "✅ اتسجلت التفويلة:\n";
        reply += fuelSt.full ? "⛽ قولت (كامل)\n" : `⛽ ${liters} لتر\n`;
        reply += `💰 التكلفة: ${cost} ج (${fuelPrice} ج/لتر)\n`;
        reply += `📟 العداد: ${km.toLocaleString()} كم\n`;
        if (dist) reply += `📏 المسافة: ${dist.toLocaleString()} كم\n`;
        if (avg) reply += `🔥 المعدل: ${avg.toFixed(1)} كم/لتر\n`;
        reply += `⛽ المتوقع يمشي: ~${Math.round(liters * rangeKmPerL)} كم\n🙏 ربنا يوصلك بالأمان!`;
        delete global._fuelState[client.phone];
        await handleOdometerReply(client, String(km));
        await sendTextMessage(client.phone, reply);
        await sendMainMenu(client);
        return;
      }
    }

    // رقم 3-7 خانات = قراءة عداد مباشرة (من غير ما يدوس من القايمة الأول)
    if (/^\d{3,7}$/.test(text)) {
      await handleOdometerReply(client, text);
      return;
    }

    // أي كلام تاني -> المساعد الذكي (Gemini) بسياق عربية العميل
    await handleSmartAssistant(client, text);
    return;
  }

  // أي نوع تاني (صورة، صوت...) -> نرد بالقايمة الرئيسية كـ افتراضي آمن
  await sendMainMenu(client);
}


// -----------------------------------------------------------------------------
// المساعد الذكي: أي رسالة نصية حرة بتتبعت لـ Gemini ومعاها سياق عربية العميل،
// فبيرد رد مفيد بالمصري ويوجهه لاختيارات القايمة — بدل "مش فاهمك ابعت قايمة".
// -----------------------------------------------------------------------------
async function handleSmartAssistant(client, userText) {
  const car = client.car || {};

  // حماية صارمة على مستوى الكود (مش مجرد تعليمات نصية لـ Gemini، اللي ممكن
  // يتجاهلها أحيانًا ويخترع بيانات بديلة). لو مفيش بيانات عربية حقيقية
  // (لا ماركة ولا موديل)، منستدعيش Gemini خالص عشان منديهوش الفرصة يخترع.
  if (!car.brand && !car.model) {
    await sendTextMessage(
      client.phone,
      "معنديش بيانات عربيتك متسجلة لسه 🚗\nافتح تطبيق IDEA CarHub 360° وسجّل بيانات عربيتك الأول، وبعدها هقدر أساعدك بكل التفاصيل."
    );
    await sendMainMenu(client);
    return;
  }

  try {
    const maint = (client.maintenance || [])
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    // ملخص مضغوط: آخر سجل لكل نوع صيانة
    const seen = new Set();
    const maintLines = [];
    for (const m of maint) {
      if (seen.has(m.type)) continue;
      seen.add(m.type);
      maintLines.push(`${m.type}: آخر مرة عند ${m.km || "?"} كم بتاريخ ${m.date || "?"}${m.kmInt ? " (كل " + m.kmInt + " كم)" : ""}`);
      if (maintLines.length >= 10) break;
    }
    const specs = client.rawData && client.rawData.carSpecs ? JSON.stringify(client.rawData.carSpecs).slice(0, 900) : "";

    const prompt =
`انت مساعد ذكي لتطبيق IDEA CarHub 360 لصيانة العربيات، بترد على واتساب بالعامية المصرية.
قواعد إلزامية:
1) ممنوع تماماً تنادي العميل بأي اسم. ابدأ الرد على طول من غير تحية باسم.
2) ممنوع تخترع أي معلومة مش موجودة في البيانات تحت.
3) لو محتاج تشير للمصدر قول "من قاعدة بيانات IDEA CarHub 360°" — متقولش ذكاء اصطناعي.
بيانات عربية العميل:
- العربية: ${car.brand || ""} ${car.model || ""} ${car.year || ""} — لوحة: ${car.plate || ""}
- قراءة العداد الحالية: ${car.km || "غير معروفة"} كم
- سجل الصيانات: ${maintLines.join(" | ") || "مفيش سجلات"}
${specs ? "- مواصفات المصنع: " + specs : ""}

اختيارات القايمة اللي يقدر يدوس عليها: 🚗 حالة العربية / 📋 حالة الرخصة / 🔧 أقرب صيانات / 📊 سجل قراءة العداد (أو يبعت الرقم مباشرة) / 🚨 المخالفات / ⛽ أقرب محطة وقود / 📞 الأرقام الهامة.

رسالة العميل: "${userText.slice(0, 400)}"

رد عليه رد مفيد ومختصر (5 سطور بالكتير، من غير تنسيق Markdown):
- لو سؤال عن عربيته جاوب من بياناتها اللي فوق بالأرقام.
- لو سؤال نصيحة عربيات عامة (زيوت، حرارة، أعطال) جاوب باختصار كخبير صيانة، ولو المواصفات فيها الإجابة استخدمها.
- لو طلبه موجود في القايمة قوله يدوس على أنهي اختيار بالظبط.
- متقولش "مش فاهم" أبداً.`;

    const r = await geminiGenerate({ prompt, jsonMode: false, timeoutMs: 20000 });
    if (r.error || !r.text) throw new Error(r.error || "empty");
    let reply = r.text.trim().replace(/\*\*/g, "").slice(0, 1500);
    // حماية صارمة: امسح أي نداء باسم من رد Gemini مهما كان
    reply = reply
      .replace(/\bيا\s+(?:أستاذ|استاذ|مهندس|دكتور|كابتن|حاج|باشا)?\s*[\u0600-\u06FF]+\s*[,،!.]?/gu, "")
      .replace(/\b(أهلا|أهلاً|اهلا|مرحبا|مرحباً|صباح الخير|مساء الخير)\s+[\u0600-\u06FF]+\b/gu, "$1")
      .replace(/^[\s,،.!]+/, "")
      .trim();
    // الاسم الموثوق من الشيت بنحطه إحنا (مش Gemini)
    const realName = String(client.name || "").trim();
    if (realName) reply = "يا " + realName.split(/\s+/)[0] + "، " + reply;

    await sendTextMessage(client.phone, reply);
  } catch (e) {
    console.warn("SmartAssistant fallback:", e.message);
    await sendTextMessage(client.phone, "وصلتني رسالتك 👌 اختار من القايمة اللي جاية أو اكتب سؤالك عن عربيتك بشكل مباشر.");
  }
  await sendMainMenu(client);
}

// -----------------------------------------------------------------------------
// القايمة الرئيسية (Interactive List) — بترجع بعد أي رسالة من العميل
// -----------------------------------------------------------------------------
async function sendMainMenu(client) {
  const firstName = client.name ? client.name.split(" ")[0] : "";
  await sendInteractiveList(client.phone, {
    header: "IDEA CarHub 360 🚗",
    body: firstName ? `أهلاً ${firstName}! اختار اللي يناسبك:` : "أهلاً بيك! اختار اللي يناسبك:",
    footer: "خدمة عملاء ايديا",
    buttonText: "عرض الخيارات",
    sections: [
      {
        title: "خدمات عربيتك",
        rows: [
          { id: "menu_car_status", title: "🚗 حالة العربية", description: "الزيت، الكاوتش، آخر صيانة" },
          { id: "menu_license_status", title: "📋 حالة الرخصة", description: "تاريخ الانتهاء وفاضل كام يوم" },
          { id: "menu_next_service", title: "🔧 أقرب صيانات", description: "الصيانة الجاية والكيلومتر" },
          { id: "menu_violations", title: "🚨 المخالفات", description: "المخالفات المسجلة على عربيتك" },
        ],
      },
      {
        title: "تسجيل وتحديث",
        rows: [
          { id: "menu_fuel_log", title: "⛽ تسجيل تفويلة", description: "سجل البنزين واحسب الاستهلاك" },
          { id: "menu_dealer_schedule", title: "🏢 صيانات التوكيل", description: "جدول التوكيل الرسمي لعربيتك" },
        ],
      },
      {
        title: "خدمات إضافية",
        rows: [
          { id: "menu_important_numbers", title: "📞 الأرقام الهامة", description: "أرقام الإدارة + أرقامك المحفوظة" },
          { id: "menu_full_report", title: "📊 التقرير الكامل", description: "كل التفاصيل دفعة واحدة" },
          { id: "menu_toggle_notif", title: "🔕 إيقاف/تشغيل التنبيهات", description: "تحكم في الرسايل اليومية" },
          { id: "menu_support", title: "💬 تواصل مع الدعم", description: "كلم فريق ايديا مباشرة" },
        ],
      },
    ],
  });
}

// -----------------------------------------------------------------------------
// معالجة اختيار العميل من القايمة أو الأزرار
// -----------------------------------------------------------------------------
async function handleMenuSelection(client, selectedId) {
  try {
    await handleMenuSelectionInner(client, selectedId);
  } catch (e) {
    console.error("handleMenuSelection error:", selectedId, e.message, e.stack);
    await sendTextMessage(client.phone, "⚠️ حصل خطأ مؤقت، جرب تاني أو ابعت 'قائمة' من الأول.");
    try { await sendMainMenu(client); } catch {}
  }
}

async function handleMenuSelectionInner(client, selectedId) {
  switch (selectedId) {
    case "menu_car_status":
    case "btn_more_details": {
      const status = getCarStatus(client);
      if (!status) {
        await sendTextMessage(client.phone, "معلش، مش لاقيين بيانات عربيتك دلوقتي. كلم الدعم من فضلك.");
        break;
      }
      const lines = [
        `🚗 *${status.brand} ${status.model} ${status.year}*`,
        `الكيلومتراج الحالي: ${status.km.toLocaleString("ar-EG")} كم`,
        ``,
        `🛢️ زيت الموتور: ${status.oil.statusText}`,
        status.oil.lastDate ? `   آخر تغيير: ${status.oil.lastDate} عند ${status.oil.lastKm ?? "--"} كم` : "",
        ``,
        `🔵 الكاوتش: ${status.tires.statusText}`,
        status.tires.lastDate ? `   آخر تغيير: ${status.tires.lastDate} عند ${status.tires.lastKm ?? "--"} كم` : "",
      ].filter(Boolean);
      await sendTextMessage(client.phone, lines.join("\n"));
      await sendMainMenu(client);
      break;
    }

    case "menu_license_status": {
      const lic = getLicenseStatus(client);
      if (!lic || !lic.hasDate) {
        await sendTextMessage(client.phone, "مفيش تاريخ انتهاء رخصة مسجل لعربيتك. تقدر تضيفه من التطبيق.");
      } else {
        await sendTextMessage(client.phone, `📋 رخصة السيارة:\nتاريخ الانتهاء: ${lic.expiryDate}\n${lic.statusText}`);
      }
      await sendMainMenu(client);
      break;
    }

    case "menu_next_service": {
      const next = getNextService(client);
      if (!next) {
        await sendTextMessage(client.phone, "مفيش سجل صيانات كفاية عشان نحسبلك الصيانة الجاية. سجل الصيانات من التطبيق الأول.");
      } else {
        const kmTxt = next.kmLeft !== null ? `${next.kmLeft} كم` : "غير محدد";
        const daysTxt = next.daysLeft !== null ? `${next.daysLeft} يوم` : "غير محدد";
        await sendTextMessage(
          client.phone,
          `🔧 أقرب صيانة جاية: *${next.name}*\nمتبقي: ${kmTxt} أو ${daysTxt} (الأقرب)\nالحالة: ${next.statusText}`
        );
      }
      await sendMainMenu(client);
      break;
    }

    case "menu_violations": {
      const v = getViolationsStatus(client);
      if (!v.count) {
        await sendTextMessage(client.phone, "🎉 مفيش مخالفات غير مدفوعة على عربيتك دلوقتي.");
      } else {
        const lines = v.unpaid
          .slice(0, 5)
          .map((x) => `• ${x.type} — ${x.amount} جنيه (بتاريخ ${x.date})`)
          .join("\n");
        await sendTextMessage(client.phone, `🚨 عندك ${v.count} مخالفة غير مدفوعة:\n${lines}`);
      }
      await sendMainMenu(client);
      break;
    }

    case "menu_odometer":
    case "btn_log_odometer": {
      await setPendingAction(client.code, client.carId, "odometer");
      await sendTextMessage(client.phone, "📊 اكتب قراءة العداد الحالية (بالكيلومتر) وابعتها رقم بس، مثال: 45230");
      break;
    }

    case "menu_fuel_log": {
      // بدأ flow التفويلة
      await sendTextMessage(client.phone,
        "⛽ تسجيل تفويلة:\n\n1️⃣ قولت (ملأ التانك كامل)\n2️⃣ عدد لترات معين\n\nابعت 1 أو 2");
      // نحفظ الحالة في memory المؤقتة — العميل هيرد بـ1 أو 2
      if (typeof global._fuelState === "undefined") global._fuelState = {};
      global._fuelState[client.phone] = { step: "choose_type" };
      break;
    }

    case "menu_dealer_schedule": {
      const { readSheet: readSheetDS } = await import("@/lib/googleSheets");
      let dealerTxt = "";
      try {
        const dsRows = await readSheetDS("DealerSchedules");
        const carBrand = (client.car?.brand || "").toLowerCase().trim();
        const carModel = (client.car?.model || "").toLowerCase().trim();
        const carKm = Number(client.car?.km) || 0;
        const hit = dsRows.find(r =>
          (r.Brand||"").toLowerCase().trim() === carBrand &&
          (r.Model||"").toLowerCase().trim() === carModel
        );
        if (hit?.Schedule) {
          const sched = JSON.parse(hit.Schedule);
          const sorted = sched.slice().sort((a,b) => a.km - b.km);
          const current = sorted.filter(x => x.km <= carKm).pop();
          const next = sorted.find(x => x.km > carKm);
          dealerTxt = `🏢 جدول صيانات التوكيل\n${client.car?.brand||""} ${client.car?.model||""} — ${carKm.toLocaleString()} كم\n`;
          if (current) dealerTxt += `\n✅ آخر صيانة: ${current.km.toLocaleString()} كم\n${(current.operations||[]).slice(0,3).join("\n")}`;
          if (next) dealerTxt += `\n\n👈 الصيانة الجاية: ${next.km.toLocaleString()} كم\nباقي: ${Math.max(0,next.km-carKm).toLocaleString()} كم${next.is_major?" (كبيرة)":""}\n${(next.operations||[]).slice(0,4).join("\n")}`;
        } else {
          dealerTxt = "🏢 جدول التوكيل لعربيتك مش محمّل بعد.\nافتح التطبيق > صيانات > فعّل سويتش 'صيانة في التوكيل؟' عشان يتحمّل.";
        }
      } catch (e) { dealerTxt = "⚠️ تعذر جلب جدول التوكيل: " + e.message; }
      await sendTextMessage(client.phone, dealerTxt);
      await sendMainMenu(client);
      break;
    }

    case "menu_full_report": {
      const { buildFullReport } = await import("@/lib/google-sheets");
      const fullStatus = getCarStatus(client);
      if (!fullStatus) { await sendTextMessage(client.phone, "مفيش بيانات كافية للتقرير دلوقتي."); break; }
      const repLines = [
        `📊 *التقرير الكامل — ${fullStatus.brand} ${fullStatus.model}*`,
        `📟 العداد: ${fullStatus.km.toLocaleString()} كم`,``,
        `🛢️ الزيت: ${fullStatus.oil.statusText}`,
        `🔵 الكاوتش: ${fullStatus.tires.statusText}`,
        `🔧 أقرب صيانة: ${fullStatus.nextService ? fullStatus.nextService.name + " — باقي " + fullStatus.nextService.kmLeft.toLocaleString() + " كم" : "مفيش سجلات"}`,
        (client.violations||[]).filter(v=>!v.paid).length ? `🚨 مخالفات غير مدفوعة: ${(client.violations||[]).filter(v=>!v.paid).length}` : `✅ مفيش مخالفات`,
      ].filter(Boolean);
      await sendTextMessage(client.phone, repLines.join("\n"));
      await sendMainMenu(client);
      break;
    }

    case "menu_toggle_notif": {
      const { readSheet: rs2, updateRow: ur2 } = await import("@/lib/googleSheets");
      let nowOn = true;
      try {
        const rows2 = await rs2("ClientData");
        const row2 = rows2.find((r) => r.Code === client.code);
        if (row2 && row2.DataJSON) {
          const data2 = JSON.parse(row2.DataJSON);
          const cars2 = Array.isArray(data2.cars) ? data2.cars : [];
          const car2 = cars2.find((c) => c.id === client.carId) || cars2[0];
          if (car2) {
            car2.notifEnabled = car2.notifEnabled === false; // اقلب الحالة
            nowOn = car2.notifEnabled;
            await ur2("ClientData", row2._row, { DataJSON: JSON.stringify(data2) });
          }
        }
      } catch (e) { console.warn("toggle notif:", e.message); }
      await sendTextMessage(client.phone, nowOn
        ? "🔔 تم تشغيل التنبيهات اليومية ✅"
        : "🔕 تم إيقاف التنبيهات اليومية.\nتقدر ترجعها من نفس المفتاح أو من التطبيق.");
      await sendMainMenu(client);
      break;
    }

    case "menu_important_numbers": {
      // أرقام الإدارة الثابتة + أرقام العميل المحفوظة في التطبيق
      let txt = "📞 الأرقام الهامة\n";
      try {
        const adminRows = await readSheet("AdminNumbers");
        const fixed = adminRows.filter((r) => r.Name && r.Phone);
        if (fixed.length) {
          txt += "\n📌 من الإدارة:\n";
          fixed.forEach((r) => {
            txt += `• ${r.Name}: ${r.Phone}${r.Address ? " — " + r.Address : ""}\n`;
          });
        }
      } catch (e) {}
      const myContacts = (client.rawData && Array.isArray(client.rawData.contacts)) ? client.rawData.contacts : [];
      if (myContacts.length) {
        txt += "\n👤 أرقامك المحفوظة:\n";
        myContacts.slice(0, 15).forEach((c) => {
          txt += `• ${c.name || "بدون اسم"}: ${c.phone || ""}\n`;
        });
      }
      if (!txt.includes("•")) txt += "\nمفيش أرقام محفوظة لسه — ضيفها من التطبيق صفحة أرقام هامة.";
      await sendTextMessage(client.phone, txt.trim());
      await sendMainMenu(client);
      break;
    }
    case "menu_fuel_station": {
      // ثابت بسيط دلوقتي (رابط جوجل مابس للبحث القريب) — يمكن تطويره لاحقًا بربط
      // Google Maps Places API فعلي لو حبيت نتائج ديناميكية حسب موقع العميل.
      await sendTextMessage(
        client.phone,
        "⛽ أقرب محطات الوقود:\nابعتلنا موقعك (📎 > Location) ونبعتلك أقرب محطة، أو دور على خرائط جوجل:\nhttps://www.google.com/maps/search/محطة+بنزين+بالقرب+مني"
      );
      await sendMainMenu(client);
      break;
    }

    case "menu_support":
    case "btn_support": {
      const supportNumber = process.env.NEXT_PUBLIC_COMPANY_WHATSAPP_NUMBER || "";
      await sendTextMessage(
        client.phone,
        (supportNumber
          ? `📞 تقدر تكلم فريق الدعم مباشرة هنا:\nhttps://wa.me/${supportNumber}`
          : "📞 فريق الدعم هيتواصل معاك في أقرب وقت.") +
          "\n\n💡 لو اسمك ظاهر غلط في الرسايل، ابعتلي: اسمي [اسمك الصح]"
      );
      break;
    }

    default:
      await sendMainMenu(client);
  }
}

// -----------------------------------------------------------------------------
// معالجة رد العميل بعد ما اختار "سجل قراءة العداد"
// -----------------------------------------------------------------------------
async function handleOdometerReply(client, text) {
  const digitsOnly = text.replace(/[^\d]/g, "");
  if (!digitsOnly) {
    await sendTextMessage(client.phone, "من فضلك اكتب رقم قراءة العداد بس (مثال: 45230).");
    return;
  }

  const result = await saveOdometerToSheet(client, digitsOnly);
  if (!result.ok) {
    await sendTextMessage(client.phone, `⚠️ ${result.error}`);
    return;
  }

  await sendTextMessage(
    client.phone,
    `✅ تم تحديث قراءة العداد لـ ${result.km.toLocaleString("ar-EG")} كم لعربية ${result.carBrand} ${result.carModel}.`
  );
  await sendMainMenu(client);
}

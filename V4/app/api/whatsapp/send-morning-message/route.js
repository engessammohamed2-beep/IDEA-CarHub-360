import { NextResponse } from "next/server";
import { getAllOptedInClients, getCarStatus, getLicenseStatus, getNextService, getViolationsStatus } from "@/lib/google-sheets";
import { sendTemplateMessage, sendTextMessage, sendButtonsMessage } from "@/lib/whatsapp";
import { requireAdminSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// أقصى مدة تنفيذ (بعض الاستضافات بتحتاج تحديد صريح لو عندك عملاء كتير)
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// رسالة الصباح اليومية — بتتبعت لكل عميل مفعّل واتساب (D.settings.morningMessageEnabled
// !== false) وعنده رقم واتساب مربوط بعربيته (car.waPhone).
//
// ملاحظة مهمة عن الـ Template:
// واتساب بيزنس API بيتطلب إن أي رسالة تتبعت **بعد أكتر من 24 ساعة** من آخر رسالة
// جاية من العميل تكون "Template Message" متوافق عليها مسبقًا من Meta (WhatsApp
// Manager -> Message Templates -> Create Template). التمبلت اسمه هنا
// "daily_morning_update" (متغيّر عبر WHATSAPP_MORNING_TEMPLATE_NAME في .env).
// لحد ما يتعمل ويتوافق عليه من Meta (بياخد من دقايق لساعات)، الكود هنا بيرجع
// تلقائيًا (fallback) لإرسال رسالة نصية عادية بنفس المحتوى، عشان النظام يفضل
// شغال ومنتظرش موافقة Meta قبل ما تقدر تجرب/تشتغل.
// -----------------------------------------------------------------------------

const TEMPLATE_NAME = process.env.WHATSAPP_MORNING_TEMPLATE_NAME || "daily_morning_update";
const TEMPLATE_LANG = process.env.WHATSAPP_MORNING_TEMPLATE_LANG || "ar_EG";

function buildMorningText(client) {
  const carStatus = getCarStatus(client);
  const licStatus = getLicenseStatus(client);
  const nextService = getNextService(client);
  const violations = getViolationsStatus(client);

  // الصيغة المطلوبة:
  //   صباح الخير يا {الاسم من ClientData}
  //   حالة عربيتك تمام / الزيت كويس / الرخص لسه بدري
  //   + لو عنده مخالفة قريبة يقوله، ولو عنده صيانة قريبة يقوله فاضل كام كيلو
  //   وآخر الرسالة: توصل بالسلامة إن شاء الله
  //   وتحتها زرار: سجل قراءة العداد لو حابب
  const name = client.name || "صديقنا";
  const lines = [
    `صباح الخير يا ${name} ☀️`,
    "🤲 «سُبْحَانَ الَّذِي سَخَّرَ لَنَا هَذَا وَمَا كُنَّا لَهُ مُقْرِنِينَ وَإِنَّا إِلَى رَبِّنَا لَمُنْقَلِبُونَ»",
  ];

  const oilOk = !carStatus || carStatus.oil.status === "ok";
  const licOk = !licStatus || !licStatus.hasDate || licStatus.status === "ok";
  const hasCloseViolation = violations.count > 0;
  const hasCloseService =
    nextService &&
    ((nextService.kmLeft !== null && nextService.kmLeft <= 1000) ||
      (nextService.daysLeft !== null && nextService.daysLeft <= 30));

  if (oilOk && licOk && !hasCloseViolation && !hasCloseService) {
    lines.push("حالة عربيتك تمام، الزيت كويس والرخص لسه بدري ✅");
  } else {
    lines.push(oilOk ? "الزيت كويس ✅" : `الزيت: ${carStatus.oil.statusText} 🛢️`);
    if (licStatus && licStatus.hasDate) {
      lines.push(licOk ? "الرخص لسه بدري ✅" : `الرخصة: ${licStatus.statusText} 📋`);
    }
  }

  if (hasCloseViolation) {
    lines.push(`عندك ${violations.count} مخالفة قريبة محتاجة دفع 🚨`);
  }

  if (hasCloseService) {
    const kmTxt =
      nextService.kmLeft !== null
        ? `فاضل ${nextService.kmLeft} كم`
        : `فاضل ${nextService.daysLeft} يوم`;
    lines.push(`عندك صيانة قريبة (${nextService.name}) — ${kmTxt} 🔧`);
  }

  lines.push("", "توصل بالسلامة إن شاء الله 🚗💨");
  return lines.join("\n");
}

async function sendMorningMessageToClient(client) {
  const text = buildMorningText(client);

  // نبعت لتليجرام كمان لو العميل مربوط بيه (بغض النظر عن نتيجة الواتساب) —
  // القناتين مستقلتين عن بعض تمامًا، فلو حد فشل ميوقفش التاني
  if (client.tgChatId) {
    try {
      const { sendTelegramMessage, mainKeyboard } = await import("@/lib/telegram");
      await sendTelegramMessage(client.tgChatId, text, mainKeyboard());
    } catch (e) {
      console.warn("sendMorningMessageToClient: فشل إرسال تليجرام:", e.message);
    }
  }

  // نحاول الـ Template الأول (المطلوب فعليًا لو أكتر من 24 ساعة من آخر رسالة من
  // العميل). لو فشل (لسه مش متوافق عليه من Meta، أو مش موجود أصلاً)، نرجع لرسالة
  // نصية + أزرار عادية كـ fallback عشان الخدمة تفضل شغالة.
  const templateResult = await sendTemplateMessage(client.phone, TEMPLATE_NAME, TEMPLATE_LANG, [
    {
      type: "body",
      parameters: [{ type: "text", text }],
    },
  ]);

  if (templateResult.ok) return { ok: true, via: "template" };

  // Fallback: رسالة نصية عادية + أزرار [سجل قراءة العداد] [تفاصيل أكتر]
  const textResult = await sendTextMessage(client.phone, text);
  if (!textResult.ok) return { ok: false, error: textResult.error };

  await sendButtonsMessage(client.phone, "لو حابب تسجل قراءة العداد دوس هنا 👇", [
    { id: "btn_log_odometer", title: "سجل قراءة العداد" },
    { id: "btn_more_details", title: "تفاصيل أكتر" },
  ]);

  return { ok: true, via: "text_fallback", templateError: templateResult.error };
}

export async function GET(req) {
  return handleMorningBroadcast(req);
}
export async function POST(req) {
  return handleMorningBroadcast(req);
}

async function handleMorningBroadcast(req) {
  const { searchParams } = new URL(req.url);
  const testTarget = searchParams.get("target"); // "admin" | "all" | null (يعني تشغيل الكرون العادي)

  // وضع التجربة اليدوية من صفحة الإعدادات: لازم جلسة أدمن صالحة، مش
  // CRON_SECRET (ده مخصص للكرون التلقائي بس)
  if (testTarget) {
    const admin = await requireAdminSession();
    if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  } else {
    // حماية الـ endpoint: Vercel Cron بيبعت Header "Authorization: Bearer <CRON_SECRET>"
    // تلقائي لو ضبطته في vercel.json، وكرون خارجي (cron-job.org) ينفع يبعته يدوي.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.get("authorization") || "";
      const querySecret = searchParams.get("secret");
      const ok = authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret;
      if (!ok) {
        return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
      }
    }
  }

  // Vercel هو المصدر الوحيد لرسالة الصبح دلوقتي (بعد نقل تليجرام هنا كمان) —
  // الافتراضي بقى "مفعّل". لو حابب توقفه لأي سبب، حط
  // MORNING_MESSAGE_ENABLED=false في .env.
  // ملحوظة: وضع التجربة اليدوية (testTarget) بيتجاوز السويتش ده — الأدمن
  // بيقدر يجرب حتى لو الرسالة اليومية التلقائية موقوفة مؤقتًا.
  const globalEnabled = String(process.env.MORNING_MESSAGE_ENABLED || "true").toLowerCase() !== "false";
  if (!globalEnabled && !testTarget) {
    return NextResponse.json({ ok: true, skipped: "الرسالة اليومية بتتبعت من الأسكربت بس دلوقتي (Vercel معطّل افتراضيًا)" });
  }

  try {
    let clients = await getAllOptedInClients();

    if (testTarget === "admin") {
      clients = clients.filter((c) => c.role === "admin");
    }
    // testTarget === "all" أو null: كل العملاء زي ما هي (السلوك الافتراضي)

    const results = [];

    for (const client of clients) {
      try {
        const r = await sendMorningMessageToClient(client);
        results.push({ phone: client.phone, code: client.code, ...r });
      } catch (e) {
        results.push({ phone: client.phone, code: client.code, ok: false, error: e.message });
      }
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return NextResponse.json({
      ok: true,
      testMode: !!testTarget,
      target: testTarget || "cron",
      totalClients: clients.length,
      sent,
      failed,
      results,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

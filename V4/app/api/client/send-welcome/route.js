import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { sendTextMessage } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// بيبني نص رسالة الترحيب — بيوضح اسم العميل، بيانات عربيته، وترحيب باسم
// شركة IDEA، بنفس الأسلوب اللي طلبه صاحب المشروع.
function buildWelcomeText({ ownerName, brand, model, year }) {
  const firstName = (ownerName || "").trim().split(/\s+/)[0] || "";
  let msg = "🎉 أهلاً" + (firstName ? " يا " + firstName : "") + "!\n\n";
  msg += "تم تسجيل عربيتك بنجاح في IDEA CarHub 360° ✅\n\n";
  if (brand) {
    msg += "🚗 عربيتك: " + brand + (model ? " " + model : "") + (year ? " " + year : "") + "\n\n";
  }
  msg += "من دلوقتي هتقدر تتابع كل حاجة خاصة بعربيتك (الصيانات، الوقود، الرخص، المخالفات) من التطبيق، ومن بوتات الواتساب والتليجرام كمان.\n\n";
  msg += "شكراً لثقتك في IDEA EG 🙏\nربنا يوصلك بالأمان دايماً 🚗💨";
  return msg;
}

// POST { waPhone, tgChatId, ownerName, brand, model, year }
// بيبعت رسالة ترحيب لأي قناة اتحطلها بيانات (واتساب و/أو تليجرام)، بدل ما
// نعتمد على الأسكربت القديم (اللي بقى مش مصدر الحقيقة لأي حاجة دلوقتي).
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const { waPhone, tgChatId, ownerName, brand, model, year } = body;

  const text = buildWelcomeText({ ownerName, brand, model, year });
  const results = { whatsapp: null, telegram: null };

  if (waPhone) {
    try {
      results.whatsapp = await sendTextMessage(waPhone, text);
    } catch (e) {
      results.whatsapp = { ok: false, error: e.message };
    }
  }

  if (tgChatId) {
    try {
      const { sendTelegramMessage, mainKeyboard } = await import("@/lib/telegram");
      results.telegram = await sendTelegramMessage(tgChatId, text, mainKeyboard());
    } catch (e) {
      results.telegram = { ok: false, error: e.message };
    }
  }

  return NextResponse.json({ ok: true, results });
}

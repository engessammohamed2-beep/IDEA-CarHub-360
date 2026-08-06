import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { sendTextMessage } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function buildLowFuelText({ ownerName, brand, model, litersRemaining }) {
  const firstName = (ownerName || "").trim().split(/\s+/)[0] || "";
  const carName = [brand, model].filter(Boolean).join(" ") || "عربيتك";
  let msg = "⛽ تنبيه مستوى الوقود" + (firstName ? " — " + firstName : "") + "\n\n";
  msg += `مستوى الوقود في ${carName} وصل لحوالي ${litersRemaining} لتر، وهو أقل من الحد الأدنى الموصى به (10 لتر).\n\n`;
  msg += "يُنصح بالتزود بالوقود في أقرب وقت ممكن، مع مراعاة عدم ترك المستوى ينخفض بشكل متكرر — إذ يساهم وجود كمية كافية من الوقود في تبريد طرمبة البنزين الغاطسة، ويقلل من فرصة سحب الرواسب المتراكمة في قاع التانك إلى فلتر الوقود.";
  return msg;
}

// POST { waPhone, tgChatId, ownerName, brand, model, litersRemaining }
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const { waPhone, tgChatId, ownerName, brand, model, litersRemaining } = body;

  const text = buildLowFuelText({ ownerName, brand, model, litersRemaining });
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

import axios from "axios";
import { logMessage } from "@/lib/whatsapp";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — Telegram Bot API integration
// -----------------------------------------------------------------------------
// المتطلبات في .env.local:
//   TELEGRAM_BOT_TOKEN
// نفس فلسفة lib/whatsapp.js: مصدر الحقيقة الوحيد لبيانات العميل هو تاب
// ClientData، وتاب Users بيربط chatId (تليجرام أو واتساب) بكود الترخيص.
// -----------------------------------------------------------------------------

function requireToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("تليجرام مش مضبوط: محتاج TELEGRAM_BOT_TOKEN في .env.local");
  }
  return token;
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${requireToken()}/${method}`;
}

// لوحة المفاتيح الرئيسية (Reply Keyboard) — بتظهر تحت خانة الكتابة في تليجرام
export function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "📊 حالة العربية" }, { text: "🪪 بيانات الرخصة" }],
      [{ text: "⛽ تسجيل تفويلة" }, { text: "📍 تسجيل عداد" }],
      [{ text: "🔧 أقرب صيانات" }, { text: "🚦 المخالفات" }],
      [{ text: "📊 التقرير الكامل" }, { text: "📞 الأرقام الهامة" }],
      [{ text: "قائمة" }],
    ],
    resize_keyboard: true,
  };
}

// بيبعت القايمة الرئيسية كرسالة ترحيبية — بديل تليجرام لـ sendMainMenu
// بتاعة الواتساب (اللي بتستخدم قوايم تفاعلية مش متاحة بنفس الشكل هنا)
export async function sendTelegramMainMenu(chatId, client) {
  const firstName = client?.name ? client.name.split(" ")[0] : "";
  const text = firstName ? `أهلاً ${firstName}! اختار من تحت 👇` : "أهلاً بيك! اختار من تحت 👇";
  return sendTelegramMessage(chatId, text, mainKeyboard());
}


// ---------------------------------------------------------------------------
// إرسال رسالة نصية عادية، مع دعم اختياري للوحة مفاتيح مخصصة
// ---------------------------------------------------------------------------
export async function sendTelegramMessage(chatId, text, replyMarkup) {
  // معرّفات wa: هي عملاء واتساب فقط (تليجرام مش مربوط) — منبعتلهمش تليجرام
  if (!chatId || String(chatId).indexOf("wa:") === 0) return { ok: false, error: "chatId من نوع واتساب" };
  try {
    const payload = { chat_id: chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await axios.post(apiUrl("sendMessage"), payload);
    await logMessage({ phone: String(chatId), direction: "out", messageType: "telegram_text", content: text, raw: res.data });
    return { ok: true, data: res.data };
  } catch (e) {
    const errMsg = e.response?.data?.description || e.message;
    console.error("sendTelegramMessage error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// إرسال رسالة ترحيب بعد الربط الناجح (/start CODE) — بنفس أسلوب رسالة
// الترحيب في الأسكربت القديم
// ---------------------------------------------------------------------------
export async function sendTelegramWelcome(chatId, client) {
  const car = client?.car || {};
  const ownerFirst = (client?.name || "").trim().split(/\s+/)[0] || "";
  let msg = "🎉 أهلاً" + (ownerFirst ? " يا " + ownerFirst : "") + "!\n";
  msg += "تم ربط حسابك بتطبيق IDEA CarHub 360° بنجاح ✅\n\n";
  if (car.brand) {
    msg += "🚗 عربيتك: " + car.brand + " " + (car.model || "") + " " + (car.year || "") + "\n";
    if (car.plate) msg += "🔢 اللوحة: " + car.plate + "\n";
    if (car.km) msg += "📟 العداد: " + Number(car.km).toLocaleString() + " كم\n";
  }
  msg += "\n📩 هتوصلك رسالة صباحية يومياً بحالة عربيتك\n";
  msg += "\nشكراً لاختيارك IDEA EG 🙏\nربنا يوصلك بالأمان دايماً";
  return sendTelegramMessage(chatId, msg, mainKeyboard());
}

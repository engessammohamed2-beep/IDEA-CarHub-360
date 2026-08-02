import axios from "axios";
import { readSheet, appendRow, ensureClientDataTab, ensureWhatsAppMessagesTab } from "@/lib/googleSheets";

// -----------------------------------------------------------------------------
// IDEA CarHub 360 — WhatsApp Cloud API integration
// -----------------------------------------------------------------------------
// المتطلبات في .env.local:
//   PHONE_NUMBER_ID, WABA_ID, ACCESS_TOKEN, WEBHOOK_VERIFY_TOKEN
// مصدر الحقيقة الوحيد لبيانات العميل هو تاب ClientData (عمود DataJSON) اللي هو
// بالظبط نفس الـ "D" الكائن اللي البرنامج (public/app/index.html) بيشتغل بيه:
//   D.cars[]        -> كل عربية (brand, model, km, carLicExp, waPhone...)
//   D.maintenance[]  -> كل عمليات الصيانة (type, date, km, kmInt, monInt)
//   D.violations[]   -> المخالفات (date, type, amount, paid)
// مفيش تاب اسمه "Cars" أو "Licenses" منفصل ببيانات العربية — Licenses tab هو
// أكواد تفعيل البرنامج نفسه (License codes)، مش رخصة القيادة/السيارة.
// -----------------------------------------------------------------------------

const GRAPH_VERSION = "v20.0";

function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

function requireEnv() {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const accessToken = process.env.ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp غير مضبوط: محتاج PHONE_NUMBER_ID و ACCESS_TOKEN في .env.local");
  }
  return { phoneNumberId, accessToken };
}

function authHeaders(accessToken) {
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
}

// ---------------------------------------------------------------------------
// إرسال رسالة نصية عادية
// ---------------------------------------------------------------------------
export async function sendTextMessage(to, body) {
  const { phoneNumberId, accessToken } = requireEnv();
  const url = graphUrl(`${phoneNumberId}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
  try {
    const res = await axios.post(url, payload, authHeaders(accessToken));
    await logMessage({ phone: to, direction: "out", messageType: "text", content: body, raw: res.data });
    return { ok: true, data: res.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error("sendTextMessage error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// إرسال قايمة تفاعلية (Interactive List) — القايمة الرئيسية بعد أي رسالة من العميل
// ---------------------------------------------------------------------------
export async function sendInteractiveList(to, { header, body, footer, buttonText, sections }) {
  const { phoneNumberId, accessToken } = requireEnv();
  const url = graphUrl(`${phoneNumberId}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header: { type: "text", text: header } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        button: buttonText || "اختر من هنا",
        sections,
      },
    },
  };
  try {
    const res = await axios.post(url, payload, authHeaders(accessToken));
    await logMessage({
      phone: to,
      direction: "out",
      messageType: "interactive_list",
      content: body,
      raw: res.data,
    });
    return { ok: true, data: res.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error("sendInteractiveList error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// إرسال زرارين سريعين (Reply Buttons) — مستخدمة في رسالة الصباح [سجل قراءة العداد] [تفاصيل أكتر]
// ---------------------------------------------------------------------------
export async function sendButtonsMessage(to, body, buttons) {
  const { phoneNumberId, accessToken } = requireEnv();
  const url = graphUrl(`${phoneNumberId}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
  try {
    const res = await axios.post(url, payload, authHeaders(accessToken));
    await logMessage({ phone: to, direction: "out", messageType: "button", content: body, raw: res.data });
    return { ok: true, data: res.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error("sendButtonsMessage error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// إرسال Template Message (لرسالة الصباح، لازم تكون متوافق عليها من Meta الأول)
// ---------------------------------------------------------------------------
export async function sendTemplateMessage(to, templateName, languageCode, components) {
  const { phoneNumberId, accessToken } = requireEnv();
  const url = graphUrl(`${phoneNumberId}/messages`);
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode || "ar_EG" },
      ...(components ? { components } : {}),
    },
  };
  try {
    const res = await axios.post(url, payload, authHeaders(accessToken));
    await logMessage({
      phone: to,
      direction: "out",
      messageType: "template",
      content: `template:${templateName}`,
      raw: res.data,
    });
    return { ok: true, data: res.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error("sendTemplateMessage error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// تسجيل الرسالة في تاب WhatsAppMessages (للـ dashboard اللي بيعرضها live)
// ---------------------------------------------------------------------------
export async function logMessage({ phone, clientCode = "", clientName = "", direction, messageType, content, raw }) {
  try {
    const tabName = await ensureWhatsAppMessagesTab();
    await appendRow(tabName, {
      Timestamp: new Date().toISOString(),
      Phone: phone || "",
      ClientCode: clientCode || "",
      ClientName: clientName || "",
      Direction: direction,
      MessageType: messageType,
      Content: content || "",
      RawJSON: raw ? JSON.stringify(raw).slice(0, 5000) : "",
    });
  } catch (e) {
    // فشل تسجيل اللوج منمنعش الرد الأساسي من الوصول للعميل
    console.warn("logMessage: فشل تسجيل الرسالة في الشيت:", e.message);
  }
}

// ---------------------------------------------------------------------------
// تحديث عام لأي حقل في بيانات عربية معينة عند عميل معين (يستخدم لحفظ
// "pending action" — يعني إحنا مستنيين رد معين من العميل زي قراءة العداد،
// وأي حاجة تانية محتاجة تتحفظ في car.* من غير ما نكرر منطق قراءة/كتابة الشيت).
// ---------------------------------------------------------------------------
export async function patchClientCar(clientCode, carId, patch) {
  const tabName = await ensureClientDataTab();
  const rows = await readSheet(tabName);
  const row = rows.find((r) => r.Code === clientCode);
  if (!row || !row.DataJSON) return { ok: false, error: "بيانات العميل غير موجودة" };

  let data;
  try {
    data = JSON.parse(row.DataJSON);
  } catch {
    return { ok: false, error: "بيانات العميل تالفة" };
  }

  const cars = data.cars || [];
  const car = cars.find((c) => c.id === carId);
  if (!car) return { ok: false, error: "العربية غير موجودة" };

  Object.assign(car, patch);
  data.updatedAt = Date.now();

  const { updateRow } = await import("@/lib/googleSheets");
  await updateRow(tabName, row._row, {
    Code: clientCode,
    DataJSON: JSON.stringify(data),
    UpdatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

/** يسجّل إننا مستنيين رد معين من العميل (مثلاً "odometer") عشان الرسالة الجاية تتفسر صح. */
export async function setPendingAction(clientCode, carId, action) {
  return patchClientCar(clientCode, carId, { waPendingAction: action || "" });
}

// ---------------------------------------------------------------------------
// حفظ قراءة العداد الجديدة في بيانات العربية (D.car.km) — يعدّل الـ DataJSON
// المخزون في ClientData لنفس العميل. بياخد الـ client object اللي رجعته
// getClientByPhone (عشان نتجنب قراءة الشيت مرتين لنفس الطلب).
// ---------------------------------------------------------------------------
export async function saveOdometerToSheet(client, newKm) {
  if (!client || !client.code || !client.carId) {
    return { ok: false, error: "بيانات العميل غير مكتملة" };
  }

  const kmNum = parseInt(newKm, 10);
  if (!Number.isFinite(kmNum) || kmNum <= 0) {
    return { ok: false, error: "قراءة العداد غير صالحة. اكتب رقم صحيح بس." };
  }

  const currentKm = Number(client.car.km) || 0;
  if (currentKm && kmNum < currentKm) {
    return {
      ok: false,
      error: `القراءة الجديدة (${kmNum}) أقل من آخر قراءة مسجلة (${currentKm}). تأكد من الرقم.`,
      currentKm,
    };
  }

  const tabName = await ensureClientDataTab();
  const rows = await readSheet(tabName);
  const row = rows.find((r) => r.Code === client.code);
  if (!row || !row.DataJSON) {
    return { ok: false, error: "بيانات العميل غير موجودة في الشيت" };
  }

  let data;
  try {
    data = JSON.parse(row.DataJSON);
  } catch {
    return { ok: false, error: "بيانات العميل تالفة (JSON غير صالح)" };
  }

  const cars = data.cars || [];
  const car = cars.find((c) => c.id === client.carId);
  if (!car) {
    return { ok: false, error: "العربية غير موجودة عند هذا العميل" };
  }

  car.km = kmNum;
  car.kmUpdatedAt = new Date().toISOString();
  car.kmUpdatedVia = "whatsapp";
  car.waPendingAction = ""; // خلاص خدنا الرد المستني، نمسح الحالة
  data.updatedAt = Date.now();

  const { updateRow } = await import("@/lib/googleSheets");
  await updateRow(tabName, row._row, {
    Code: client.code,
    DataJSON: JSON.stringify(data),
    UpdatedAt: new Date().toISOString(),
  });

  return { ok: true, km: kmNum, carBrand: car.brand, carModel: car.model };
}

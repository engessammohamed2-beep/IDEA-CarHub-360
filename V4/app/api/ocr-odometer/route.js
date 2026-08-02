import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { geminiGenerate } from "@/lib/aiSettings";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST { imageBase64, mediaType }  →  { km } أو { error }
// بيستخدم Gemini Vision بالإعدادات المحفوظة من صفحة الأدمن.
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });

  let body = {};
  try { body = await req.json(); } catch {}
  const imageBase64 = (body.imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
  const mediaType = body.mediaType || "image/jpeg";
  if (!imageBase64) return NextResponse.json({ error: "مفيش صورة" }, { status: 400 });
  if (imageBase64.length > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "الصورة كبيرة جداً، صغّرها وجرب تاني" }, { status: 413 });
  }

  const prompt =
    'دي صورة عداد/طابلوه عربية. مطلوب منك حاجتين:\n' +
    '1) استخرج قراءة العداد الكلية بالكيلومتر (الرقم الرئيسي الكبير للـ odometer، مش الـ trip).\n' +
    '2) شوف لو فيه لمبات تحذير منوّرة فعلاً في الطابلوه (مضيئة، مش مجرد مرسومة ومطفية).\n' +
    'رجع JSON فقط بدون أي شرح بالشكل ده:\n' +
    '{"km": 123456, "confidence": "high|medium|low", "warning_lights": [{"key": "check_engine", "label": "لمبة الشيك (Check Engine)"}]}\n' +
    'المفاتيح المسموحة للمبات: check_engine, battery, oil_pressure, temperature, abs, airbag, brake, tpms, fuel_low, other.\n' +
    'لو مفيش لمبات منورة رجع "warning_lights": []. لو مش شايف رقم عداد واضح رجع "km": null.';

  const r = await geminiGenerate({
    prompt,
    imageBase64,
    imageMediaType: mediaType,
    jsonMode: true,
    timeoutMs: 25000,
  });
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });

  let km = null, confidence = "low", lights = [];
  try {
    const cleaned = r.text.trim().replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : cleaned);
    if (parsed && parsed.km != null) km = parseInt(parsed.km, 10);
    if (parsed && parsed.confidence) confidence = parsed.confidence;
    if (parsed && Array.isArray(parsed.warning_lights)) {
      lights = parsed.warning_lights
        .filter((l) => l && (l.key || l.label))
        .map((l) => ({ key: String(l.key || "other"), label: String(l.label || l.key || "لمبة تحذير") }))
        .slice(0, 10);
    }
  } catch {
    const m = (r.text || "").match(/\d{3,7}/g);
    if (m) km = parseInt(m.sort((a, b) => b.length - a.length)[0], 10);
  }
  if ((!km || isNaN(km) || km <= 0) && !lights.length) {
    return NextResponse.json({ error: "معرفناش نقرأ رقم واضح من الصورة" }, { status: 422 });
  }
  return NextResponse.json({ km: km && km > 0 ? km : null, confidence, warning_lights: lights, model: r.model });
}

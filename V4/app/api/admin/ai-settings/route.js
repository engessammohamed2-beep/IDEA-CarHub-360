import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { getAISettings, saveAISettings, geminiGenerate, defaultAISettings } from "@/lib/aiSettings";

export const runtime = "nodejs";

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "••••••••" + k.slice(-4);
}

// الموديلات المرشحة للاختبار (بالترتيب من الأقوى للأسرع)
const CANDIDATE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

export async function GET() {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  const s = await getAISettings();
  const def = defaultAISettings();
  return NextResponse.json({
    apiUrl: s.apiUrl,
    model: s.model,
    apiKeyMasked: maskKey(s.apiKey),
    hasKey: !!s.apiKey,
    savedInSheet: !!s.savedInSheet,
    envFallback: { apiUrl: def.apiUrl, model: def.model, hasEnvKey: !!def.apiKey },
    candidates: CANDIDATE_MODELS,
    updatedAt: s.updatedAt || null,
  });
}

export async function POST(req) {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });

  let body = {};
  try { body = await req.json(); } catch {}
  const action = body.action || "save";

  // ---- حفظ الإعدادات (كل العملاء هيشتغلوا عليها فوراً) ----
  if (action === "save") {
    const apiUrl = (body.apiUrl || "").trim();
    const apiKey = (body.apiKey || "").trim(); // فاضي = سيب المفتاح القديم/env
    const model = (body.model || "").trim();
    if (apiUrl && !/^https?:\/\//i.test(apiUrl)) {
      return NextResponse.json({ error: "رابط الـ API لازم يبدأ بـ http/https" }, { status: 400 });
    }
    // لو المفتاح فاضي، احتفظ بالمحفوظ حالياً
    const current = await getAISettings();
    await saveAISettings({
      apiUrl: apiUrl || current.apiUrl,
      apiKey: apiKey || current.apiKey,
      model: model || current.model,
    });
    const s = await getAISettings();
    return NextResponse.json({ ok: true, apiUrl: s.apiUrl, model: s.model, apiKeyMasked: maskKey(s.apiKey) });
  }

  // ---- اختبار الموديلات وترشيح الأفضل ----
  if (action === "test") {
    // لو الأدمن كاتب مفتاح/رابط جديد في الفورم وعايز يجربه قبل الحفظ:
    const tempKey = (body.apiKey || "").trim();
    const tempUrl = (body.apiUrl || "").trim();
    if (tempKey || tempUrl) {
      const current = await getAISettings();
      await saveAISettings({
        apiUrl: tempUrl || current.apiUrl,
        apiKey: tempKey || current.apiKey,
        model: current.model,
      });
    }

    // (1) نسأل جوجل نفسها: إيه الموديلات المتاحة للمفتاح ده دلوقتي؟
    let models = Array.isArray(body.models) && body.models.length ? body.models : null;
    let discovered = [];
    if (!models) {
      try {
        const s = await getAISettings();
        const base = s.apiUrl.replace(/\/+$/, "");
        const lr = await fetch(`${base}/models?key=${encodeURIComponent(s.apiKey)}&pageSize=100`, {
          headers: { "x-goog-api-key": s.apiKey },
        });
        if (lr.ok) {
          const lj = await lr.json();
          discovered = (lj.models || [])
            .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
            .map((m) => m.name.replace(/^models\//, ""))
            // نستبعد الموديلات المتخصصة (صوت/صور/embedding/تفكير tts) ونفضّل flash/pro
            .filter((n) => !/embedding|aqa|tts|audio|image|imagen|veo|learnlm/i.test(n));
          // ترتيب: flash العادي الأول (أوفر في الكوتة)، بعدين lite، بعدين pro، بعدين الباقي
          const rank = (n) =>
            /flash(?!-lite)/i.test(n) && !/preview|exp/i.test(n) ? 0 :
            /flash-lite/i.test(n) && !/preview|exp/i.test(n) ? 1 :
            /pro/i.test(n) && !/preview|exp/i.test(n) ? 2 : 3;
          discovered.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
          models = discovered.slice(0, 8);
        }
      } catch (e) { /* هنقع على القايمة الثابتة */ }
      if (!models || !models.length) models = CANDIDATE_MODELS;
    }

    const results = [];
    for (const model of models) {
      const t0 = Date.now();
      const r = await geminiGenerate({
        prompt: 'رجع JSON فقط: {"ok":true,"model":"' + model + '"}',
        modelOverride: model,
        jsonMode: true,
        timeoutMs: 20000,
      });
      const ms = Date.now() - t0;
      let ok = false;
      if (!r.error && r.text) {
        try { ok = JSON.parse(r.text).ok === true; } catch { ok = r.text.includes("ok"); }
      }
      results.push({ model, ok, ms, error: r.error || null });
    }
    // الأفضل = أول موديل ناجح بالترتيب (الأقوى)، ولو عايز الأسرع بيظهر في الجدول
    const best = results.find((r) => r.ok) || null;
    return NextResponse.json({ ok: true, results, best: best ? best.model : null, discovered });
  }

  return NextResponse.json({ error: "action غير معروف" }, { status: 400 });
}

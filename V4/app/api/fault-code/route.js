import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { geminiGenerate } from "@/lib/aiSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST { code, brand, model, year } -> شرح كود العطل
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const code = (body.code || "").trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "اكتب كود العطل" }, { status: 400 });

  const car = [body.brand, body.model, body.year].filter(Boolean).join(" ");
  const prompt =
`انت فني تشخيص أعطال سيارات خبير في مصر.
كود العطل: ${code}
${car ? "العربية: " + car : ""}

رجع JSON فقط بالشكل ده بدون أي كلام بره:
{
  "code": "${code}",
  "known": true,
  "title": "اسم العطل بالعربي",
  "meaning": "يعني ايه بالظبط في جملتين بالعامية المصرية",
  "severity": "بسيط|متوسط|خطير",
  "can_drive": "ينفع تمشي بيها|امشي بحذر لأقرب مركز|متمشيش وروح ونش",
  "causes": ["سبب محتمل 1", "سبب محتمل 2", "سبب محتمل 3"],
  "checks": ["افحص كذا الأول", "بعدين كذا"],
  "cost_hint": "تكلفة الإصلاح التقريبية في مصر"
}
لو الكود مش معروف رجع "known": false مع شرح مختصر في meaning. متخترعش معلومات.`;

  const r = await geminiGenerate({ prompt, jsonMode: true, timeoutMs: 25000 });
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });
  try {
    const cleaned = r.text.trim().replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    return NextResponse.json({ result: JSON.parse(m ? m[0] : cleaned) });
  } catch {
    return NextResponse.json({ error: "تعذر تحليل رد الذكاء الاصطناعي" }, { status: 502 });
  }
}

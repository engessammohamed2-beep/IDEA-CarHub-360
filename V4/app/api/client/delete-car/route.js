import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { archiveCarData } from "@/lib/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { car, maintenance, fuel, violations, faults, reason }
// بيحفظ نسخة كاملة من العربية المحذوفة في تاب Archive قبل ما تختفي نهائيًا.
// الحذف الفعلي من ClientData بيحصل عن طريق الفرونت إند (D.cars بتتصفّى محليًا
// وبعدين save() بتبعت النسخة الجديدة كاملة) — الـ endpoint ده مسؤول بس عن
// الحفظ في الأرشيف، مش عن الحذف نفسه.
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const { car, maintenance, fuel, violations, faults, reason } = body;

  if (!car || !car.id) {
    return NextResponse.json({ error: "بيانات العربية ناقصة" }, { status: 400 });
  }

  try {
    const result = await archiveCarData({
      code: session.code,
      car,
      maintenance: maintenance || [],
      fuel: fuel || [],
      violations: violations || [],
      faults: faults || [],
      reason: reason || "client_deleted",
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message || "تعذر حفظ الأرشيف" }, { status: 500 });
  }
}

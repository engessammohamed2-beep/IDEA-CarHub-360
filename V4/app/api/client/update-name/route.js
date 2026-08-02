import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { updateClientNameInLicenses } from "@/lib/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { name } — بيحدّث "Client Name" في تاب Licenses مباشرة، وهو المصدر
// الموحّد اللي كل حاجة (الواتساب، التليجرام، رسالة الصباح) بتقرا الاسم منه.
// كده العميل لما يكتب اسمه من التطبيق، بيتحدث فعليًا في المصدر الموثوق
// مش بس في بيانات عربيته المحلية.
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const name = (body.name || "").trim();
  if (!name) return NextResponse.json({ error: "الاسم مطلوب" }, { status: 400 });

  const ok = await updateClientNameInLicenses(session.code, name);
  if (!ok) return NextResponse.json({ error: "تعذر تحديث الاسم (الكود مش موجود في التراخيص؟)" }, { status: 404 });
  return NextResponse.json({ ok: true, name });
}

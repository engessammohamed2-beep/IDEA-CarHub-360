import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";

export const runtime = "nodejs";

// GET -> بيقول للأدمن هل GEMINI_API_KEY متضبط في السيرفر ولا لأ، من غير ما يرجّع
// قيمة المفتاح نفسه أبداً (حتى لو أدمن، المفتاح ده سري ومكانه .env بس).
export async function GET() {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });

  const geminiConfigured = !!process.env.GEMINI_API_KEY;
  return NextResponse.json({ geminiConfigured });
}

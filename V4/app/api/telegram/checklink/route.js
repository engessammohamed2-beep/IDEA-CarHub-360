import { NextResponse } from "next/server";
import { readSheet, ensureUsersTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET ?code=IDEA_XXXX — بيرجع { chatId } لو الكود ده اتربط بحساب تليجرام
// فعلًا (يعني العميل دوس /start CODE على البوت قبل كده)، أو { chatId: null }
// لو لسه معملش. ده بديل Vercel لنفس "action=checklink" اللي كانت الأسكربت
// القديمة بترجعها، عشان زرار "اربطني بالبوت" في التطبيق يفضل شغال بنفس
// المنطق من غير ما يحتاج تعديل في الفرونت إند.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = (searchParams.get("code") || "").trim();
  if (!code) return NextResponse.json({ chatId: null, error: "code مطلوب" }, { status: 400 });

  try {
    const usersTab = await ensureUsersTab();
    const rows = await readSheet(usersTab).catch(() => []);
    // نلاقي آخر صف مرتبط بالكود ده وعنده chatId رقمي (تليجرام، مش wa:)
    const row = rows.find((r) => String(r.code || "").trim() === code && r.chatId && String(r.chatId).indexOf("wa:") !== 0);
    return NextResponse.json({ chatId: row ? row.chatId : null });
  } catch (e) {
    return NextResponse.json({ chatId: null, error: e.message }, { status: 500 });
  }
}

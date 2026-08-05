import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { readSheet, deleteRow } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { waPhone } — بيمسح صف العربية من تاب "Cars" القديم فعليًا (مش بس محليًا).
// ده كان السبب الحقيقي وراء "حذفت العربية بس الواتساب لسه شايف بياناتها":
// النظام القديم (تاب Cars منفصل) مكانش فيه أي كود يمسح منه خالص، فأي صف
// اتسجل فيه قبل كده كان بيفضل موجود للأبد حتى بعد "حذف" العربية من التطبيق.
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch {}
  const waPhone = (body.waPhone || "").toString().replace(/[^0-9]/g, "");

  try {
    const carsTab = process.env.SHEET_TAB_CARS || "Cars";
    const usersTab = process.env.SHEET_TAB_USERS || "Users";
    const rows = await readSheet(carsTab).catch(() => []);
    const t9 = (x) => {
      const n = String(x || "").replace(/[^0-9]/g, "");
      return n.length >= 9 ? n.slice(-9) : "";
    };
    const targetTail = t9(waPhone);

    // نجيب كل الـ chatId المرتبطة بكود الترخيص الحالي عن طريق تاب Users —
    // ده الإصلاح الحقيقي: قبل كده كانت المقارنة r.chatId === session.code
    // بتقارن حاجتين شكلهم مختلف تمامًا (chatId زي "wa:2010..." مقابل كود
    // زي "IDEA_4120096")، فمكانتش بتتطابق أبدًا. ده كان بيمنع مسح أي
    // عربية تجريبية اتسجلت من غير رقم واتساب مربوط خالص.
    const linkedChatIds = new Set();
    if (session.code) {
      const userRows = await readSheet(usersTab).catch(() => []);
      userRows.forEach((u) => {
        if (u.code === session.code && u.chatId) linkedChatIds.add(String(u.chatId));
      });
    }

    // نمسح كل الصفوف اللي بتاعت نفس رقم الواتساب، أو أي chatId مرتبط بنفس
    // كود الترخيص الحالي (يغطي الحالة اللي مفيش فيها waPhone مسجل خالص)
    const toDelete = rows.filter((r) => {
      const rPhone = t9(r.waPhone || "");
      const isPhoneMatch = targetTail && rPhone === targetTail;
      const isLinkedChatId = r.chatId && linkedChatIds.has(String(r.chatId));
      return isPhoneMatch || isLinkedChatId;
    });

    // نمسح بترتيب عكسي (من الأسفل للأعلى) عشان أرقام الصفوف متتزحلقش
    // مع بعض أثناء الحذف المتتالي
    toDelete.sort((a, b) => b._row - a._row);
    for (const row of toDelete) {
      await deleteRow(carsTab, row._row);
    }

    return NextResponse.json({ ok: true, deletedRows: toDelete.length });
  } catch (e) {
    return NextResponse.json({ error: e.message || "تعذر المسح من تاب Cars القديم" }, { status: 500 });
  }
}

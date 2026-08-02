import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { readSheet, ensureWhatsAppMessagesTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET -> يرجّع سجل رسائل واتساب (كل الرسائل، أو مفلترة بكود عميل واحد عبر ?code=)
// بيستخدمها /client/dashboard/whatsapp-messages لعرض المحادثات "live" بالـ polling.
// أي عميل عادي بيشوف رسائله هو بس (مفلترة بكوده)؛ الأدمن بيشوف كل حاجة.
export async function GET(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  try {
    const tabName = await ensureWhatsAppMessagesTab();
    const rows = await readSheet(tabName);

    const isAdmin = String(session.role || "").toLowerCase() === "admin";
    const { searchParams } = new URL(req.url);
    const filterCode = searchParams.get("code");

    let filtered = rows;
    if (!isAdmin) {
      // العميل العادي يشوف بس رسايله (بكوده)
      filtered = rows.filter((r) => r.ClientCode === session.code);
    } else if (filterCode) {
      filtered = rows.filter((r) => r.ClientCode === filterCode);
    }

    // أحدث الرسائل الأول مش لازم؛ نرجعها بترتيب الوقت تصاعدي زي أي شات، ونحدد آخر 200 رسالة بس
    const sorted = filtered
      .map((r) => ({
        timestamp: r.Timestamp,
        phone: r.Phone,
        clientCode: r.ClientCode,
        clientName: r.ClientName,
        direction: r.Direction,
        messageType: r.MessageType,
        content: r.Content,
      }))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-200);

    return NextResponse.json({ messages: sorted });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

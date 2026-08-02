import { NextResponse } from "next/server";
import { getClientSession, requireAdminSession } from "@/lib/auth";
import { readSheet, appendRow, deleteRow, ensureLicensesTab } from "@/lib/googleSheets";
import { getSheetsClient, SHEET_ID, supabaseEnabled } from "@/lib/googleSheets";

export const runtime = "nodejs";

const TAB = "AdminNumbers";
const HEADERS = ["Name", "Phone", "Address", "Note"];

async function ensureTab() {
  if (supabaseEnabled()) return TAB; // مش محتاجين هيدر في Supabase
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${TAB}!A1:D1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] },
    });
  }
  return TAB;
}

// GET: أي عميل مسجل يشوف الأرقام الثابتة اللي الأدمن حاططها (قراءة فقط)
export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });
  try {
    await ensureTab();
    const rows = await readSheet(TAB);
    return NextResponse.json({
      numbers: rows
        .filter((r) => r.Name || r.Phone)
        .map((r) => ({ name: r.Name || "", phone: r.Phone || "", address: r.Address || "", note: r.Note || "", _row: r._row })),
    });
  } catch (e) {
    return NextResponse.json({ numbers: [], error: e.message });
  }
}

// POST: الأدمن يضيف رقم/عنوان ثابت
export async function POST(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  let body = {};
  try { body = await req.json(); } catch {}
  const name = (body.name || "").trim();
  const phone = (body.phone || "").trim();
  if (!name || !phone) return NextResponse.json({ error: "الاسم والرقم مطلوبين" }, { status: 400 });
  await ensureTab();
  await appendRow(TAB, { Name: name, Phone: phone, Address: (body.address || "").trim(), Note: (body.note || "").trim() });
  return NextResponse.json({ ok: true });
}

// DELETE: الأدمن يمسح رقم (?row=رقم الصف)
export async function DELETE(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  const row = parseInt(new URL(req.url).searchParams.get("row"), 10);
  if (!row || row < 2) return NextResponse.json({ error: "رقم صف غير صالح" }, { status: 400 });
  await deleteRow(TAB, row);
  return NextResponse.json({ ok: true });
}

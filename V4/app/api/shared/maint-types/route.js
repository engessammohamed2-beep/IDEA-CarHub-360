import { NextResponse } from "next/server";
import { getClientSession, requireAdminSession } from "@/lib/auth";
import { readSheet, appendRow, deleteRow, getSheetsClient, SHEET_ID, supabaseEnabled } from "@/lib/googleSheets";

export const runtime = "nodejs";

const TAB = "MaintTypes";
const HEADERS = ["Key", "Name", "Icon", "KmInterval", "MonthInterval", "Fields", "CreatedAt"];

async function ensureTab() {
  if (supabaseEnabled()) return TAB;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${TAB}!A1:G1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] },
    });
  }
  return TAB;
}

// GET: أي عميل مسجل بياخد أنواع الصيانة اللي الأدمن ضافها
export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });
  try {
    await ensureTab();
    const rows = await readSheet(TAB);
    return NextResponse.json({
      types: rows
        .filter((r) => r.Key && r.Name)
        .map((r) => ({
          key: r.Key,
          name: r.Name,
          icon: r.Icon || "🔩",
          kmInt: parseInt(r.KmInterval) || 0,
          monInt: parseInt(r.MonthInterval) || 0,
          fields: (() => { try { return JSON.parse(r.Fields || "[]"); } catch { return []; } })(),
          _row: r._row,
        })),
    });
  } catch (e) {
    return NextResponse.json({ types: [], error: e.message });
  }
}

// POST: الأدمن يضيف نوع صيانة جديد لكل العملاء
export async function POST(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  let body = {};
  try { body = await req.json(); } catch {}
  const name = (body.name || "").trim();
  if (!name) return NextResponse.json({ error: "اسم الصيانة مطلوب" }, { status: 400 });

  await ensureTab();
  const rows = await readSheet(TAB);
  if (rows.some((r) => (r.Name || "").trim() === name)) {
    return NextResponse.json({ error: "الاسم ده متسجل قبل كده" }, { status: 400 });
  }
  const key = "adm_" + Date.now().toString(36);
  await appendRow(TAB, {
    Key: key,
    Name: name,
    Icon: (body.icon || "🔩").trim(),
    KmInterval: parseInt(body.kmInt) || 0,
    MonthInterval: parseInt(body.monInt) || 0,
    Fields: JSON.stringify(Array.isArray(body.fields) ? body.fields : []),
    CreatedAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true, key });
}

// DELETE: الأدمن يمسح نوع (?row=)
export async function DELETE(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  const row = parseInt(new URL(req.url).searchParams.get("row"), 10);
  if (!row || row < 2) return NextResponse.json({ error: "رقم صف غير صالح" }, { status: 400 });
  await deleteRow(TAB, row);
  return NextResponse.json({ ok: true });
}

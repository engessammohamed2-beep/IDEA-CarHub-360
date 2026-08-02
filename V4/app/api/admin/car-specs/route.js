import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, appendRow, ensureCarSpecsTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const tabName = await ensureCarSpecsTab();
    const rows = await readSheet(tabName);
    return NextResponse.json({ specs: rows });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const body = await req.json();
    if (!body.EngineType) return NextResponse.json({ error: "نوع الموتور مطلوب" }, { status: 400 });

    const tabName = await ensureCarSpecsTab();
    const rows = await readSheet(tabName);
    const exists = rows.some((r) => String(r.EngineType).trim().toLowerCase() === String(body.EngineType).trim().toLowerCase());
    if (exists) {
      return NextResponse.json({ error: "نوع الموتور ده مسجل بالفعل" }, { status: 400 });
    }

    await appendRow(tabName, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, updateRow, deleteRow, ensureCarSpecsTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function findRow(tabName, engineType) {
  const rows = await readSheet(tabName);
  return rows.find((r) => String(r.EngineType).trim().toLowerCase() === decodeURIComponent(engineType).trim().toLowerCase());
}

export async function PATCH(req, { params }) {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const tabName = await ensureCarSpecsTab();
    const row = await findRow(tabName, params.engineType);
    if (!row) return NextResponse.json({ error: "نوع الموتور مش موجود" }, { status: 404 });

    const body = await req.json();
    await updateRow(tabName, row._row, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const tabName = await ensureCarSpecsTab();
    const row = await findRow(tabName, params.engineType);
    if (!row) return NextResponse.json({ error: "نوع الموتور مش موجود" }, { status: 404 });

    await deleteRow(tabName, row._row);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

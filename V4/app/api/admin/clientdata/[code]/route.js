import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, ensureClientDataTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/admin/clientdata/:code -> full app data (all cars, maintenance, etc.) for one client
export async function GET(req, { params }) {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const { code } = params;
    const tabName = await ensureClientDataTab();
    const rows = await readSheet(tabName);
    const row = rows.find((r) => r.Code === code);

    if (!row || !row.DataJSON) {
      return NextResponse.json({ data: null });
    }

    let data = null;
    try {
      data = JSON.parse(row.DataJSON);
    } catch {
      data = null;
    }

    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, appendRow, ensureLicensesTab } from "@/lib/googleSheets";
import { generateCode, computeExpiryDate, serializePages } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET -> list all licenses (admin panel table)
export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  try {
    const tabName = await ensureLicensesTab();
    const licenses = await readSheet(tabName);
    // newest first
    licenses.reverse();
    return NextResponse.json({ licenses });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST -> generate a new license code
export async function POST(req) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { clientName, phone, days, allowedCars, allowedPages } = body;

    if (!clientName || !phone || !days || !allowedCars) {
      return NextResponse.json({ error: "من فضلك املأ كل الحقول المطلوبة" }, { status: 400 });
    }

    const tabName = await ensureLicensesTab();
    const code = generateCode();

    const row = {
      Code: code,
      "Client Name": clientName,
      Phone: phone,
      "Created At": new Date().toISOString().slice(0, 10),
      "Expiry Date": computeExpiryDate(days),
      "Allowed Cars": allowedCars,
      "Allowed Pages": serializePages(allowedPages || []),
      Status: "Active",
      "Device ID": "",
      Role: "client",
    };

    await appendRow(tabName, row);
    return NextResponse.json({ ok: true, license: row });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}


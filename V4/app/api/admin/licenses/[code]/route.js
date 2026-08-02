import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, updateRow, deleteRow, ensureLicensesTab } from "@/lib/googleSheets";
import { computeExpiryDate, isExpired } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function findLicenseRow(tabName, code) {
  const licenses = await readSheet(tabName);
  return licenses.find((l) => l.Code === code);
}

// action: "extend" (body: { days }), "block", "unblock", "reset-device"
export async function PATCH(req, { params }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  try {
    const { code } = params;
    const body = await req.json();
    const { action, days } = body;

    const tabName = await ensureLicensesTab();
    const license = await findLicenseRow(tabName, code);
    if (!license) return NextResponse.json({ error: "الكود مش موجود" }, { status: 404 });

    const patch = {};

    if (action === "extend") {
      if (!days) return NextResponse.json({ error: "حدد عدد الأيام" }, { status: 400 });
      // extend from today if already expired, otherwise add to current expiry
      const base = isExpired(license["Expiry Date"]) ? new Date() : new Date(license["Expiry Date"]);
      base.setDate(base.getDate() + Number(days));
      patch["Expiry Date"] = base.toISOString().slice(0, 10);
      patch["Status"] = "Active";
    } else if (action === "block") {
      patch["Status"] = "Blocked";
    } else if (action === "unblock") {
      patch["Status"] = "Active";
    } else if (action === "reset-device") {
      patch["Device ID"] = "";
    } else {
      return NextResponse.json({ error: "أكشن غير معروف" }, { status: 400 });
    }

    await updateRow(tabName, license._row, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  try {
    const { code } = params;
    const tabName = await ensureLicensesTab();
    const license = await findLicenseRow(tabName, code);
    if (!license) return NextResponse.json({ error: "الكود مش موجود" }, { status: 404 });

    await deleteRow(tabName, license._row);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

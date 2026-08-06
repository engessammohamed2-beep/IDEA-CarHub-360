import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, updateRow, deleteRow, ensureLicensesTab, ensureClientDataTab } from "@/lib/googleSheets";
import { computeExpiryDate, isExpired } from "@/lib/license";
import { archiveCarData } from "@/lib/google-sheets";

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

    // نأرشف كل عربيات العميل ده من ClientData قبل ما نمسح الترخيص —
    // ده كان السبب الحقيقي وراء "حسام لسه بياناته موجودة" بعد ما اتمسح:
    // الترخيص كان بيتمسح من غير أي أرشفة خالص، فبيانات ClientData كانت
    // تفضل موجودة كـ"شبح" مش مرتبط بأي ترخيص صالح، لحد ما حد يمسحها يدويًا
    let archivedCount = 0;
    try {
      const clientDataTab = await ensureClientDataTab();
      const clientRows = await readSheet(clientDataTab).catch(() => []);
      const row = clientRows.find((r) => r.Code === code);
      if (row && row.DataJSON) {
        const data = JSON.parse(row.DataJSON);
        const cars = Array.isArray(data.cars) ? data.cars : [];
        for (const car of cars) {
          await archiveCarData({
            code,
            car,
            maintenance: data.maintenance || [],
            fuel: data.fuel || [],
            violations: data.violations || [],
            faults: data.faults || [],
            reason: "license_revoked",
          });
          archivedCount++;
        }
      }
    } catch (archiveErr) {
      console.warn("license DELETE: فشلت أرشفة العربيات، هنكمل حذف الترخيص برضه:", archiveErr.message);
    }

    await deleteRow(tabName, license._row);
    return NextResponse.json({ ok: true, archivedCars: archivedCount });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

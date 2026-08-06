import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, ensureArchiveTab, ensureClientDataTab, ensureLicensesTab, updateRow, appendRow } from "@/lib/googleSheets";
import { restoreArchivedCar } from "@/lib/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET — قايمة كل السجلات المؤرشفة (غير المُسترجَعة) عشان الأدمن يقدر يشوفها
export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }
  try {
    const archiveTab = await ensureArchiveTab();
    const rows = await readSheet(archiveTab).catch(() => []);
    const list = rows
      .filter((r) => !r.RestoredAt)
      .map((r) => ({
        row: r._row,
        archivedAt: r.ArchivedAt,
        reason: r.Reason,
        oldCode: r.OldCode,
        waPhone: r.WaPhone,
        ownerName: r.OwnerName,
        carLabel: r.CarLabel,
      }))
      .sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
    return NextResponse.json({ archived: list });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST { row, targetCode } — بيسترجع سجل مؤرشف معين، ويحطه في ClientData
// بتاع كود ترخيص موجود بالفعل (لازم يكون العميل رجع واتضاف له كود جديد
// أو نفس الكود القديم أولاً، قبل ما نسترجعله البيانات)
export async function POST(req) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { row, targetCode } = body;
  if (!row || !targetCode) {
    return NextResponse.json({ error: "محتاجين رقم السجل وكود الترخيص المستهدف" }, { status: 400 });
  }

  try {
    // نتأكد الكود المستهدف موجود فعلاً في Licenses قبل ما نحاول نسترجع عليه
    const licensesTab = await ensureLicensesTab();
    const licenseRows = await readSheet(licensesTab).catch(() => []);
    const targetLicense = licenseRows.find((l) => String(l.Code || "").trim() === String(targetCode).trim());
    if (!targetLicense) {
      return NextResponse.json({ error: "الكود المستهدف مش موجود في Licenses" }, { status: 404 });
    }

    const result = await restoreArchivedCar(row);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { snapshot } = result;
    const clientDataTab = await ensureClientDataTab();
    const clientRows = await readSheet(clientDataTab).catch(() => []);
    const existingRow = clientRows.find((r) => r.Code === targetCode);

    // نعطي العربية المسترجعة id جديد عشان منتصدمش مع عربيات موجودة بالفعل
    // لنفس العميل، ونربط باقي البيانات (صيانات/وقود/إلخ) بنفس الـ id الجديد
    const newCarId = Date.now();
    const oldCarId = snapshot.car?.id;
    const remapId = (item) => ({ ...item, carId: newCarId, id: item.id === oldCarId ? newCarId : (item.id || Date.now() + Math.random()) });
    const restoredCar = { ...snapshot.car, id: newCarId };

    if (existingRow) {
      let data;
      try {
        data = JSON.parse(existingRow.DataJSON);
      } catch {
        data = { cars: [], maintenance: [], fuel: [], violations: [], faults: [] };
      }
      data.cars = [...(data.cars || []), restoredCar];
      data.maintenance = [...(data.maintenance || []), ...(snapshot.maintenance || []).map(remapId)];
      data.fuel = [...(data.fuel || []), ...(snapshot.fuel || []).map(remapId)];
      data.violations = [...(data.violations || []), ...(snapshot.violations || []).map(remapId)];
      data.faults = [...(data.faults || []), ...(snapshot.faults || []).map(remapId)];
      await updateRow(clientDataTab, existingRow._row, {
        DataJSON: JSON.stringify(data),
        UpdatedAt: new Date().toISOString(),
      });
    } else {
      const data = {
        cars: [restoredCar],
        maintenance: (snapshot.maintenance || []).map(remapId),
        fuel: (snapshot.fuel || []).map(remapId),
        violations: (snapshot.violations || []).map(remapId),
        faults: (snapshot.faults || []).map(remapId),
      };
      await appendRow(clientDataTab, {
        Code: targetCode,
        DataJSON: JSON.stringify(data),
        UpdatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({ ok: true, restoredCarName: [restoredCar.brand, restoredCar.model].filter(Boolean).join(" ") });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

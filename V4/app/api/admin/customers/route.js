import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { readSheet, ensureLicensesTab, ensureClientDataTab } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET -> list of all client-role licenses enriched with car count + last sync time.
// Used by the "لوحة تحكم العملاء" tab inside the app's Settings screen (admin only).
export async function GET() {
  const session = await requireAdminSession();
  if (!session) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });

  try {
    const licTab = await ensureLicensesTab();
    const dataTab = await ensureClientDataTab();

    const [licenses, clientRows] = await Promise.all([readSheet(licTab), readSheet(dataTab)]);

    const dataByCode = {};
    clientRows.forEach((r) => {
      dataByCode[r.Code] = r;
    });

    const customers = licenses
      .filter((l) => String(l.Role || "").toLowerCase() !== "admin")
      .map((l) => {
        const row = dataByCode[l.Code];
        let carsCount = 0;
        if (row && row.DataJSON) {
          try {
            const parsed = JSON.parse(row.DataJSON);
            carsCount = Array.isArray(parsed.cars) ? parsed.cars.length : 0;
          } catch {}
        }
        return {
          code: l.Code,
          name: l["Client Name"],
          phone: l.Phone,
          status: l.Status,
          expiryDate: l["Expiry Date"],
          allowedCars: l["Allowed Cars"],
          carsCount,
          lastSync: row ? row.UpdatedAt : null,
        };
      });

    return NextResponse.json({ customers });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

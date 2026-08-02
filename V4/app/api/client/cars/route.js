import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { readSheet, ensureLicensesTab } from "@/lib/googleSheets";
import { evaluateLicense } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CARS_TAB = process.env.SHEET_TAB_CARS || "Cars";

export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });
  }

  try {
    // Re-validate license (expiry / block / device) before returning any data
    const licTab = await ensureLicensesTab();
    const licenses = await readSheet(licTab);
    const license = licenses.find((l) => l.Code === session.code);
    const result = evaluateLicense(license, session.deviceId);
    if (!result.ok) {
      return NextResponse.json({ error: "الترخيص غير صالح", reason: result.reason }, { status: 403 });
    }

    // "Owner ID" column in the Cars sheet is expected to hold the client's
    // license Code (e.g. IDEA-AB12CD) - that's how each client's cars are scoped.
    const allCars = await readSheet(CARS_TAB);
    let myCars = allCars.filter((c) => c["Owner ID"] === session.code);

    const allowedCars = Number(license["Allowed Cars"] || 0);
    if (allowedCars > 0) {
      myCars = myCars.slice(0, allowedCars);
    }

    return NextResponse.json({ cars: myCars, allowedCars });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

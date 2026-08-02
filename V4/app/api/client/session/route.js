import { NextResponse } from "next/server";
import { getClientSession, clearClientSession } from "@/lib/auth";
import { readSheet, ensureLicensesTab } from "@/lib/googleSheets";
import { evaluateLicense, parsePages } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Called on every app load / page change to make sure the license
// wasn't blocked, deleted, or expired since the user last logged in.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ ok: false, reason: "no_session" }, { status: 401 });
  }

  try {
    const tabName = await ensureLicensesTab();
    const licenses = await readSheet(tabName);
    const license = licenses.find((l) => l.Code === session.code);

    const result = evaluateLicense(license, session.deviceId);

    if (!result.ok) {
      clearClientSession();
      return NextResponse.json({ ok: false, reason: result.reason }, { status: 403 });
    }

    const role = String(license.Role || "").toLowerCase() === "admin" ? "admin" : "client";

    return NextResponse.json({
      ok: true,
      client: {
        code: license.Code,
        name: license["Client Name"],
        role,
        expiryDate: license["Expiry Date"],
        allowedCars: Number(license["Allowed Cars"] || 0),
        allowedPages: parsePages(license["Allowed Pages"]),
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { readSheet, appendRow, updateRow, ensureClientDataTab, ensureLicensesTab } from "@/lib/googleSheets";
import { evaluateLicense } from "@/lib/license";

export const runtime = "nodejs";

async function requireValidLicense() {
  const session = await getClientSession();
  if (!session) return { error: "غير مسجل دخول", status: 401 };

  const licTab = await ensureLicensesTab();
  const licenses = await readSheet(licTab);
  const license = licenses.find((l) => l.Code === session.code);
  const result = evaluateLicense(license, session.deviceId);
  if (!result.ok) return { error: "الترخيص غير صالح", status: 403, reason: result.reason };

  return { session, license };
}

// GET -> return this client's stored app data (the whole "D" object), or null if never saved yet
export async function GET() {
  const auth = await requireValidLicense();
  if (auth.error) return NextResponse.json({ error: auth.error, reason: auth.reason }, { status: auth.status });

  try {
    const tabName = await ensureClientDataTab();
    const rows = await readSheet(tabName);
    const row = rows.find((r) => r.Code === auth.session.code);

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

// POST -> upsert this client's full app data blob. Enforces the Allowed Cars limit server-side.
export async function POST(req) {
  const auth = await requireValidLicense();
  if (auth.error) return NextResponse.json({ error: auth.error, reason: auth.reason }, { status: auth.status });

  try {
    const body = await req.json();
    const data = body.data;
    if (!data || typeof data !== "object") {
      return NextResponse.json({ error: "بيانات غير صالحة" }, { status: 400 });
    }

    const isAdmin = String(auth.license.Role || "").toLowerCase() === "admin";
    const allowedCars = Number(auth.license["Allowed Cars"] || 0);
    if (!isAdmin && allowedCars > 0 && Array.isArray(data.cars) && data.cars.length > allowedCars) {
      // Hard cap: never persist more cars than the license allows, even if the
      // client tried to (e.g. a tampered request).
      data.cars = data.cars.slice(0, allowedCars);
      if (!data.cars.find((c) => c.id === data.activeCarId)) {
        data.activeCarId = data.cars[0]?.id;
      }
    }

    const tabName = await ensureClientDataTab();
    const rows = await readSheet(tabName);
    const existing = rows.find((r) => r.Code === auth.session.code);

    const payload = {
      Code: auth.session.code,
      DataJSON: JSON.stringify(data),
      UpdatedAt: new Date().toISOString(),
    };

    if (existing) {
      await updateRow(tabName, existing._row, payload);
    } else {
      await appendRow(tabName, payload);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

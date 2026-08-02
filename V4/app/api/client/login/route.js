import { NextResponse } from "next/server";
import { createClientSession } from "@/lib/auth";
import { readSheet, updateRow, ensureLicensesTab } from "@/lib/googleSheets";
import { evaluateLicense, parsePages } from "@/lib/license";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const { code, deviceId, remember } = await req.json();

    if (!code || !deviceId) {
      return NextResponse.json({ error: "الكود ومعرّف الجهاز مطلوبين" }, { status: 400 });
    }

    const tabName = await ensureLicensesTab();
    const licenses = await readSheet(tabName);
    const license = licenses.find((l) => l.Code === String(code).trim());

    if (!license) {
      return NextResponse.json({ error: "الكود غير صحيح", reason: "not_found" }, { status: 404 });
    }

    const role = String(license.Role || "").toLowerCase() === "admin" ? "admin" : "client";

    // First-time activation: bind this device to the code (skipped for admin,
    // who can log in from anywhere -- it's the software owner's own code).
    if (role !== "admin" && !license["Device ID"]) {
      await updateRow(tabName, license._row, { "Device ID": deviceId, Status: license.Status || "Active" });
      license["Device ID"] = deviceId;
    }

    const result = evaluateLicense(license, deviceId);

    if (!result.ok) {
      const messages = {
        blocked: "تم إيقاف هذا الكود. برجاء التواصل مع شركة ايديا.",
        expired: "تم انتهاء الفترة التجريبية برجاء الرجوع لشركة ايديا لشراء نسخة كاملة",
        device_mismatch: "هذا الكود مفعّل بالفعل على جهاز آخر. كل كود يعمل على جهاز واحد فقط.",
        not_found: "الكود غير صحيح",
      };
      return NextResponse.json(
        { error: messages[result.reason] || "الكود غير صالح", reason: result.reason },
        { status: 403 }
      );
    }

    await createClientSession({ code: license.Code, deviceId, role, remember: remember !== false });

    return NextResponse.json({
      ok: true,
      client: {
        code: license.Code,
        name: license["Client Name"],
        role,
        expiryDate: license["Expiry Date"],
        allowedCars: license["Allowed Cars"],
        allowedPages: parsePages(license["Allowed Pages"]),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

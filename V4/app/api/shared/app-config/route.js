import { NextResponse } from "next/server";
import { getClientSession, requireAdminSession } from "@/lib/auth";
import { readSheet, updateRow, appendRow, getSheetsClient, SHEET_ID, supabaseEnabled } from "@/lib/googleSheets";

export const runtime = "nodejs";

const TAB = "AppConfig";
const HEADERS = ["AppsScriptUrl", "UpdatedAt", "morningEnabled", "welcomeEnabled", "AppVersion", "Announcement", "AnnouncementId"];

async function ensureTab() {
  if (supabaseEnabled()) return TAB;
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${TAB}!A1:G1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] },
    });
  }
  return TAB;
}

// GET: أي عميل مسجل بياخد الإعدادات المركزية (رابط Apps Script للمزامنة)
export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });
  try {
    await ensureTab();
    const rows = await readSheet(TAB);
    const r = rows[0] || {};
  return NextResponse.json({
    appsScriptUrl: r.AppsScriptUrl || "",
    morningEnabled: r.morningEnabled !== "false",
    welcomeEnabled: r.welcomeEnabled !== "false",
    appVersion: r.AppVersion || "",
    announcement: r.Announcement || "",
    announcementId: r.AnnouncementId || "",
  });
  } catch (e) {
    return NextResponse.json({ appsScriptUrl: "", error: e.message });
  }
}

// POST: الأدمن يحفظ الرابط المركزي
export async function POST(req) {
  const admin = await requireAdminSession();
  if (!admin) return NextResponse.json({ error: "غير مصرح" }, { status: 403 });
  let body = {};
  try { body = await req.json(); } catch {}
  const url = (body.appsScriptUrl || "").trim();
  await ensureTab();
  const rows = await readSheet(TAB);
  const payload = {
    AppsScriptUrl: url || (rows[0] && rows[0].AppsScriptUrl) || "",
    UpdatedAt: new Date().toISOString(),
  };
  // إعدادات إضافية (morningEnabled, welcomeEnabled, ...)
  if (body.morningEnabled !== undefined) payload.morningEnabled = String(body.morningEnabled);
  if (body.welcomeEnabled !== undefined) payload.welcomeEnabled = String(body.welcomeEnabled);
  if (body.appVersion !== undefined) payload.AppVersion = String(body.appVersion).trim();
  if (body.announcement !== undefined) {
    payload.Announcement = String(body.announcement).trim();
    // معرّف جديد لكل إعلان = يظهر مرة واحدة لكل عميل
    payload.AnnouncementId = payload.Announcement ? "ann_" + Date.now().toString(36) : "";
  }
  if (rows[0] && rows[0]._row) await updateRow(TAB, rows[0]._row, payload);
  else await appendRow(TAB, payload);
  return NextResponse.json({ ok: true, appsScriptUrl: payload.AppsScriptUrl });
}

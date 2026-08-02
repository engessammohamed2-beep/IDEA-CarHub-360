import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";
import { readSheet, appendRow, ensureSharedModelsTab } from "@/lib/googleSheets";

export const runtime = "nodejs";

// GET -> { models: { "تويوتا": ["كورولا","كامري"], ... } } aggregated from every client's saved cars
export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  try {
    const tabName = await ensureSharedModelsTab();
    const rows = await readSheet(tabName);
    const models = {};
    rows.forEach((r) => {
      const brand = (r.Brand || "").trim();
      const model = (r.Model || "").trim();
      if (!brand || !model) return;
      if (!models[brand]) models[brand] = [];
      if (!models[brand].includes(model)) models[brand].push(model);
    });
    return NextResponse.json({ models });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST { brand, model } -> contribute a new brand/model pair (deduped) so other clients see it as a suggestion
export async function POST(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  try {
    const { brand, model } = await req.json();
    if (!brand || !model) return NextResponse.json({ ok: true }); // silently ignore incomplete data

    const tabName = await ensureSharedModelsTab();
    const rows = await readSheet(tabName);
    const exists = rows.some(
      (r) => (r.Brand || "").trim() === brand.trim() && (r.Model || "").trim() === model.trim()
    );
    if (!exists) {
      await appendRow(tabName, { Brand: brand.trim(), Model: model.trim() });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

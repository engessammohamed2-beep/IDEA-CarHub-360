import { NextResponse } from "next/server";
import { clearClientSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  clearClientSession();
  return NextResponse.json({ ok: true });
}

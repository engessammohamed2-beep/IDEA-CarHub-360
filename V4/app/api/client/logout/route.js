import { NextResponse } from "next/server";
import { clearClientSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST() {
  clearClientSession();
  return NextResponse.json({ ok: true });
}

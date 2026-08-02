import { NextResponse } from "next/server";

// Lightweight first line of defense (cookie presence only - full JWT
// verification + role/expiry/block/device checks happen server-side in the
// actual pages and API routes, which run on the Node.js runtime because
// they talk to Google Sheets).
export function middleware(req) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/client/dashboard")) {
    const hasSession = req.cookies.get("idea_session");
    if (!hasSession) {
      return NextResponse.redirect(new URL("/client/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/client/dashboard/:path*"],
};

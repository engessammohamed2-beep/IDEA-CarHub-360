import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

// ---------------------------------------------------------------------------
// Unified session (Owner Mode): one login flow for everyone via /client/login.
// The license's "Role" column (admin | client) decides what the user can see
// and do -- there is no separate admin cookie/login anymore.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "idea_session";

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET غير مضبوط أو قصير جدًا. ضيفه في .env.local");
  }
  return new TextEncoder().encode(secret);
}

async function sign(payload, expiresIn) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey());
}

async function verify(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload;
  } catch {
    return null;
  }
}

/** Create the session after a successful code login. role: 'admin' | 'client' */
export async function createClientSession({ code, deviceId, role, remember = true }) {
  const token = await sign({ role: role === "admin" ? "admin" : "client", code, deviceId }, "30d");
  // الافتراضي: الكوكي مش secure عشان تشتغل على HTTP و HTTPS من غير ما تسقط الجلسة
  // (secure=true بيمنع المتصفح من إرسال الكوكي إلا على HTTPS؛ لو البرنامج بيتفتح
  // على HTTP -- استضافة محلية أو IP من غير SSL -- كانت الجلسة بتسقط وبيترمي المستخدم
  // على صفحة تسجيل الدخول من غير سبب واضح). لو انت متأكد إنك على HTTPS دايمًا وعايز
  // تشدد الأمان، اضبط COOKIE_SECURE=true في .env.
  const forceSecure = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
  const cookieOpts = {
    httpOnly: true,
    secure: forceSecure,
    sameSite: "lax",
    path: "/",
  };
  if (remember) {
    cookieOpts.maxAge = 60 * 60 * 24 * 30; // persistent 30 days
  }
  // when remember=false, no maxAge -> browser session cookie (cleared on close)
  cookies().set(SESSION_COOKIE, token, cookieOpts);
}

export async function getClientSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verify(token);
  return payload && (payload.role === "client" || payload.role === "admin") ? payload : null;
}

export function clearClientSession() {
  cookies().set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

/** Convenience helper for API routes that must be admin-only. */
export async function requireAdminSession() {
  const session = await getClientSession();
  if (!session || session.role !== "admin") return null;
  return session;
}

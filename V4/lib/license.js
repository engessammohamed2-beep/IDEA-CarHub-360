import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

// These keys match the real screen names inside IDEA CarHub 360 (nav('maintenance') etc.)
// "home" and "car" (بيانات السيارة) are core screens always visible to any active client.
// "settings" (إعدادات التطبيق الداخلية) is always hidden from clients regardless of switches.
export const ALL_PAGES = [
  { key: "maintenance", label: "الصيانات" },
  { key: "fuel", label: "الوقود" },
  { key: "violations", label: "المخالفات" },
  { key: "licenses", label: "التراخيص والرخص" },
  { key: "contacts", label: "أرقام هامة" },
  { key: "trip", label: "حاسبة السفر" },
  { key: "reports", label: "التقارير والمصاريف" },
];

export function generateCode() {
  return `IDEA-${nanoid()}`;
}

export function computeExpiryDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function isExpired(expiryDateStr) {
  if (!expiryDateStr) return true;
  const expiry = new Date(expiryDateStr + "T23:59:59");
  return Date.now() > expiry.getTime();
}

export function serializePages(pageKeys) {
  return pageKeys.join(",");
}

export function parsePages(pagesStr) {
  if (!pagesStr) return [];
  return String(pagesStr)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Full license status check used on every client app load.
 * Returns { ok: boolean, reason?: 'not_found'|'blocked'|'expired'|'device_mismatch', license }
 */
export function evaluateLicense(license, deviceId, opts = {}) {
  if (!license) return { ok: false, reason: "not_found" };
  const isAdmin = String(license.Role || "").toLowerCase() === "admin";
  if (String(license.Status).toLowerCase() === "blocked") {
    return { ok: false, reason: "blocked", license };
  }
  // الأدمن مش بينتهي أبداً — بس لو اتبلوك يتوقف
  if (!isAdmin && isExpired(license["Expiry Date"])) {
    return { ok: false, reason: "expired", license };
  }
  if (!opts.skipDeviceCheck && !isAdmin && license["Device ID"] && deviceId && license["Device ID"] !== deviceId) {
    return { ok: false, reason: "device_mismatch", license };
  }
  return { ok: true, license };
}

export function whatsappLink(number, message) {
  const text = encodeURIComponent(message);
  return `https://wa.me/${number}?text=${text}`;
}

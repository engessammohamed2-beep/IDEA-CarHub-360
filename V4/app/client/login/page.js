"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getDeviceId } from "@/lib/deviceId";

export default function ClientLoginPage() {
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const router = useRouter();

  // لو المستخدم فعّل "تذكرني" قبل كده وجلسته لسه سارية، ادخله على طول من غير ما يكتب الكود تاني
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/client/session");
        const data = await res.json();
        if (res.ok && data.ok) {
          router.push("/client/dashboard");
          return;
        }
      } catch {}
      setChecking(false);
    })();
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const deviceId = getDeviceId();
      const res = await fetch("/api/client/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim().toUpperCase(), deviceId, remember }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.reason === "expired") {
          router.push("/expired");
          return;
        }
        setError(data.error || "حصل خطأ");
        return;
      }

      router.push("/client/dashboard");
    } catch {
      setError("تعذر الاتصال بالسيرفر");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return <div className="page"><div>جاري التحميل...</div></div>;
  }

  return (
    <div className="page">
      <form className="card" onSubmit={handleSubmit}>
        <div className="logo">IDEA CarHub 360</div>
        <div className="subtitle">أدخل كود التفعيل الخاص بيك</div>

        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label>كود التفعيل</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="IDEA-XXXXXX"
            required
            autoFocus
            style={{ textAlign: "center", letterSpacing: 2, fontFamily: "monospace" }}
          />
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          تذكرني (متسألنيش تاني الكود على الجهاز ده)
        </label>

        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "جاري التحقق..." : "دخول"}
        </button>
      </form>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function ClientDashboardPage() {
  const [status, setStatus] = useState("loading"); // loading | ok | blocked | device_mismatch | error
  const router = useRouter();

  useEffect(() => {
    checkSession();
    // Keep checking while the app is open in the background iframe, so a
    // block/expire/delete by the admin takes effect immediately.
    const interval = setInterval(checkSession, 60000);
    return () => clearInterval(interval);
  }, []);

  async function checkSession() {
    try {
      const res = await fetch("/api/client/session");
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (data.reason === "expired") {
          router.push("/expired");
          return;
        }
        if (data.reason === "no_session") {
          router.push("/client/login");
          return;
        }
        setStatus(data.reason || "error");
        return;
      }

      setStatus("ok");
    } catch {
      // فشل الشبكة المؤقت (الجهاز رجع من النوم أو بدّل النت) — نحاول تاني بعد 10 ثواني
      // من غير ما نظهر شاشة الخطأ فوراً
      setTimeout(checkSession, 10000);
    }
  }

  if (status === "loading") {
    return (
      <div className="page">
        <div>جاري التحميل...</div>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="page">
        <div className="card">
          <div className="error-box">تم إيقاف هذا الكود. برجاء التواصل مع شركة ايديا.</div>
        </div>
      </div>
    );
  }

  if (status === "device_mismatch") {
    return (
      <div className="page">
        <div className="card">
          <div className="error-box">هذا الكود مفعّل على جهاز آخر بالفعل.</div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="page">
        <div className="card" style={{textAlign:"center",padding:"24px"}}>
          <div style={{fontSize:"36px",marginBottom:"8px"}}>⚠️</div>
          <div style={{fontWeight:700,marginBottom:"8px"}}>انتهت الجلسة أو حصل انقطاع</div>
          <div style={{fontSize:"13px",color:"#888",marginBottom:"16px"}}>بياناتك محفوظة — دوس تاني عشان نتأكد</div>
          <button
            onClick={() => { setStatus("loading"); checkSession(); }}
            style={{background:"#2563eb",color:"#fff",border:"none",borderRadius:"8px",padding:"10px 24px",fontSize:"14px",cursor:"pointer"}}>
            🔄 المحاولة تاني
          </button>
        </div>
      </div>
    );
  }

  // status === "ok" -> load the real app. It talks to /api/client/session,
  // /api/client/appdata directly (same-origin, cookie-authenticated) and
  // hides/blocks itself according to the license -- see the bridge script
  // injected at the top of public/app/index.html.
  // نضيف timestamp كـ cache-buster — بيتغيّر مع كل تحميل للصفحة، فبيجبر
  // المتصفح يجيب نسخة جديدة من index.html بدل ما يفضل شايف نسخة قديمة
  // متخزنة لحد ما المستخدم يعمل هارد ريفريش يدوي (زي المشكلة اللي كانت
  // بتحصل قبل كده بعد كل تحديث للبرنامج).
  const buildStamp = Date.now();

  return (
    <iframe
      src={`/app/index.html?v=${buildStamp}`}
      title="IDEA CarHub 360"
      style={{ border: "none", width: "100vw", height: "100vh", display: "block" }}
    />
  );
}

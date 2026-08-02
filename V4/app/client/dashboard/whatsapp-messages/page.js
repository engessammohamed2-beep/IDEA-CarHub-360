"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// صفحة عرض رسائل واتساب "live" على شكل شات — بتعمل polling كل 5 ثواني على
// /api/whatsapp/messages وتعرض الرسائل الواردة من العملاء والصادرة من البوت.
export default function WhatsAppMessagesPage() {
  const [status, setStatus] = useState("loading"); // loading | ok | error
  const [messages, setMessages] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const router = useRouter();
  const listEndRef = useRef(null);

  useEffect(() => {
    checkSessionThenLoad();
    const interval = setInterval(loadMessages, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function checkSessionThenLoad() {
    try {
      const res = await fetch("/api/client/session");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.reason === "expired") return router.push("/expired");
        if (data.reason === "no_session") return router.push("/client/login");
        setStatus("error");
        setErrorMsg("حصل خطأ في التحقق من الترخيص.");
        return;
      }
      setStatus("ok");
      await loadMessages();
    } catch {
      setStatus("error");
      setErrorMsg("تعذر الاتصال بالسيرفر.");
    }
  }

  async function loadMessages() {
    try {
      const res = await fetch("/api/whatsapp/messages");
      const data = await res.json();
      if (res.ok && data.messages) {
        setMessages(data.messages);
      }
    } catch {
      // فشل تحديث لحظي — منعملش حاجة، هيعيد المحاولة تاني بعد 5 ثواني
    }
  }

  if (status === "loading") {
    return (
      <div style={styles.page}>
        <div>جاري التحميل...</div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={styles.page}>
        <div style={styles.errorBox}>{errorMsg}</div>
      </div>
    );
  }

  return (
    <div style={styles.page} dir="rtl">
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>💬 رسائل واتساب</h2>
        <span style={styles.liveIndicator}>● live</span>
      </div>

      <div style={styles.chatBox}>
        {messages.length === 0 && <div style={styles.emptyState}>لسه مفيش رسائل واتساب مسجلة.</div>}
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} />
        ))}
        <div ref={listEndRef} />
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  const isIn = msg.direction === "in";
  return (
    <div style={{ ...styles.bubbleRow, justifyContent: isIn ? "flex-start" : "flex-end" }}>
      <div style={{ ...styles.bubble, ...(isIn ? styles.bubbleIn : styles.bubbleOut) }}>
        {isIn && (
          <div style={styles.bubbleMeta}>
            {msg.clientName || msg.phone} · {msg.phone}
          </div>
        )}
        <div style={styles.bubbleContent}>{msg.content}</div>
        <div style={styles.bubbleTime}>
          {new Date(msg.timestamp).toLocaleString("ar-EG", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}
          {" · "}
          {msg.messageType}
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f0f2f5", padding: 16, boxSizing: "border-box", fontFamily: "Tahoma, Arial, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
  liveIndicator: { color: "#25D366", fontSize: 12, fontWeight: 700 },
  chatBox: {
    background: "#fff",
    borderRadius: 12,
    padding: 16,
    maxWidth: 720,
    margin: "0 auto",
    minHeight: "70vh",
    maxHeight: "80vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    boxShadow: "0 1px 4px rgba(0,0,0,.08)",
  },
  emptyState: { textAlign: "center", color: "#999", marginTop: 40 },
  bubbleRow: { display: "flex", width: "100%" },
  bubble: { maxWidth: "75%", padding: "8px 12px", borderRadius: 10, fontSize: 14, lineHeight: 1.6 },
  bubbleIn: { background: "#fff", border: "1px solid #e5e5e5" },
  bubbleOut: { background: "#dcf8c6" },
  bubbleMeta: { fontSize: 11, color: "#667781", marginBottom: 2, fontWeight: 700 },
  bubbleContent: { whiteSpace: "pre-wrap" },
  bubbleTime: { fontSize: 10, color: "#999", marginTop: 4, textAlign: "left" },
  errorBox: { background: "#fee", border: "1px solid #f99", padding: 16, borderRadius: 8, color: "#900" },
};

"use client";

export default function ExpiredPage() {
  const number = process.env.NEXT_PUBLIC_COMPANY_WHATSAPP_NUMBER;
  const message = encodeURIComponent(
    "السلام عليكم، الفترة التجريبية لبرنامج IDEA CarHub 360 انتهت وعايز أشترك في نسخة كاملة."
  );
  const link = number ? `https://wa.me/${number}?text=${message}` : "#";

  return (
    <div className="page">
      <div className="card" style={{ textAlign: "center" }}>
        <div className="logo">IDEA CarHub 360</div>
        <div className="error-box" style={{ marginTop: 16 }}>
          تم انتهاء الفترة التجريبية برجاء الرجوع لشركة ايديا لشراء نسخة كاملة
        </div>
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-success"
          style={{ width: "100%", textDecoration: "none", marginTop: 8 }}
        >
          تواصل عبر واتساب
        </a>
      </div>
    </div>
  );
}

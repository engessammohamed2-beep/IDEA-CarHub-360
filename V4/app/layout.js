import "./globals.css";

export const metadata = {
  title: "IDEA CarHub 360",
  description: "نظام إدارة السيارات - طبقة الترخيص",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}

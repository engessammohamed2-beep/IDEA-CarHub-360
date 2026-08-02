import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/auth";

export const runtime = "nodejs";

// بيرجع درجة الحرارة الحقيقية بره العربية من OpenWeather، مع إبقاء الـ API Key على السيرفر بس.
export async function GET(req) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "غير مسجل دخول" }, { status: 401 });

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "مفيش OPENWEATHER_API_KEY متظبط في .env عند الأدمن" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(req.url);
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");
  if (!lat || !lon) {
    return NextResponse.json({ error: "لازم إحداثيات lat و lon" }, { status: 400 });
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: data.message || "تعذر جلب الطقس" }, { status: res.status });
    }

    return NextResponse.json({
      tempC: typeof data.main?.temp === "number" ? data.main.temp : null,
      condition: data.weather?.[0]?.main || "",
      icon: data.weather?.[0]?.icon || "",
    });
  } catch (e) {
    return NextResponse.json({ error: "تعذر الاتصال بـ OpenWeather" }, { status: 500 });
  }
}

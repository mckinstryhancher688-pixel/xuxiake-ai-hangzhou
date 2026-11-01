import { JourneyApp } from "@/components/JourneyApp";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

async function TripEntry() {
  await connection();
  return process.env.TRIPS_ENABLED === "1" ? <div className="border-b border-line bg-white px-4 py-3 text-center text-sm"><Link href="/trips" className="font-medium text-brand-700">新建旅行空间：收集攻略，邀请搭子，一起确认路线 →</Link></div> : null;
}

export default function Page() {
  return <><Suspense fallback={null}><TripEntry /></Suspense><JourneyApp /></>;
}

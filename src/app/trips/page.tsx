import Link from "next/link";
import { notFound } from "next/navigation";
import { enabled } from "@/lib/server/trips/db";
import { TripCreate } from "@/components/trips/TripCreate";
import { Suspense } from "react";
import { connection } from "next/server";

export default function TripsPage() {
  return <Suspense fallback={<p className="p-10">正在打开旅行空间…</p>}><TripsContent /></Suspense>;
}
async function TripsContent() {
  await connection();
  if (!enabled()) notFound();
  return <main className="mx-auto min-h-dvh max-w-2xl px-5 py-12">
    <Link href="/" className="text-sm text-brand-700">← 徐霞客 AI</Link>
    <p className="mt-12 text-sm font-semibold tracking-widest text-brand-700">一起出发，从一份攻略开始</p>
    <h1 className="mt-3 text-3xl font-bold leading-tight text-ink-900">把收藏的攻略，变成<br />双方敢确认的真实行程。</h1>
    <div className="mt-8"><TripCreate /></div>
  </main>;
}

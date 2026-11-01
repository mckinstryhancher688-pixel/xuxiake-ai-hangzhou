import { notFound } from "next/navigation";
import { enabled } from "@/lib/server/trips/db";
import { TripWorkspaceClient } from "@/components/trips/TripWorkspaceClient";
import { Suspense } from "react";
import { connection } from "next/server";

export default function TripPage({ params }: { params: Promise<{ tripId: string }> }) {
  return <Suspense fallback={<p className="p-10">正在打开旅行空间…</p>}><TripContent params={params} /></Suspense>;
}
async function TripContent({ params }: { params: Promise<{ tripId: string }> }) {
  await connection();
  if (!enabled()) notFound();
  const { tripId } = await params;
  return <TripWorkspaceClient key={tripId} tripId={tripId} />;
}

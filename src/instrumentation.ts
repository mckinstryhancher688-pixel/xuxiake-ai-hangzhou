export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.TRIPS_ENABLED === "1") {
    const { startWorker } = await import("./lib/server/trips/worker");
    startWorker();
  }
}

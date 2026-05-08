/**
 * Set secret EDGE_FUNCTIONS_MAINTENANCE=true (or legacy MAINTENANCE_MODE=true)
 * on the Supabase project to return 503 from all Edge Functions until unset.
 */

export function maintenanceModeEnabled(): boolean {
  const v =
    Deno.env.get("EDGE_FUNCTIONS_MAINTENANCE") ?? Deno.env.get("MAINTENANCE_MODE");
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** When maintenance is on: OPTIONS succeeds (CORS); other methods get JSON 503. */
export function maintenanceGate(
  req: Request,
  cors: Record<string, string>,
): Response | null {
  if (!maintenanceModeEnabled()) return null;
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  return new Response(
    JSON.stringify({
      error: "Service temporarily unavailable",
      maintenance: true,
    }),
    {
      status: 503,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Retry-After": "3600",
      },
    },
  );
}

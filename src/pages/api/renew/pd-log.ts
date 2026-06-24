import type { APIRoute } from "astro";
import { getRenewalById, updateRenewalPdEntries } from "../../../lib/renewal-sheet";
import type { PdEntry } from "../../../lib/renewal-sheet";
import { logger } from "../../../lib/logger";

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    return Response.json({ error: "Missing token" }, { status: 400 });
  }

  let renewal;
  try {
    renewal = await getRenewalById(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("pd_log.get_failed", { err: msg, token });
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  if (!renewal) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (renewal.paymentStatus !== "paid") {
    return Response.json({ error: "Payment not confirmed" }, { status: 403 });
  }

  return Response.json({
    firstName: renewal.firstName,
    lastName: renewal.lastName,
    email: renewal.email,
    renewalYear: renewal.renewalYear,
    tier: renewal.tier,
    pdEntries: renewal.pdEntries,
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token, entries } = body as { token?: string; entries?: unknown };
  if (!token || typeof token !== "string") {
    return Response.json({ error: "Missing token" }, { status: 400 });
  }
  if (!Array.isArray(entries)) {
    return Response.json({ error: "entries must be an array" }, { status: 400 });
  }

  const cleaned: PdEntry[] = [];
  for (const raw of entries) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).dateCompleted !== "string" ||
      typeof (raw as Record<string, unknown>).activity !== "string" ||
      typeof (raw as Record<string, unknown>).totalHours !== "number" ||
      (raw as Record<string, unknown>).totalHours <= 0
    ) {
      return Response.json(
        { error: "Each entry needs dateCompleted (string), activity (string), totalHours (number > 0)" },
        { status: 400 },
      );
    }
    cleaned.push({
      dateCompleted: (raw as Record<string, unknown>).dateCompleted as string,
      activity: (raw as Record<string, unknown>).activity as string,
      totalHours: (raw as Record<string, unknown>).totalHours as number,
      provider: typeof (raw as Record<string, unknown>).provider === "string"
        ? ((raw as Record<string, unknown>).provider as string)
        : "",
    });
  }

  let renewal;
  try {
    renewal = await getRenewalById(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("pd_log.post_lookup_failed", { err: msg, token });
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  if (!renewal) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (renewal.paymentStatus !== "paid") {
    return Response.json({ error: "Payment not confirmed" }, { status: 403 });
  }

  try {
    await updateRenewalPdEntries(token, cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("pd_log.save_failed", { err: msg, token });
    return Response.json({ error: "Failed to save", retryable: true }, { status: 500 });
  }

  logger.info("pd_log.saved", { token, count: cleaned.length });
  return Response.json({ success: true });
};

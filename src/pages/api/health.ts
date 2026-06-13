import type { APIRoute } from "astro";
import Stripe from "stripe";
import { logger } from "../../lib/logger";

type SubsystemStatus = "connected" | "disconnected" | "not_configured";

interface SubsystemResult {
  status: SubsystemStatus;
  error?: string;
}

async function checkStripe(): Promise<SubsystemResult> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return { status: "not_configured" };

  try {
    const stripe = new Stripe(secretKey);
    await stripe.products.list({ limit: 1 });
    return { status: "connected" };
  } catch (err) {
    return {
      status: "disconnected",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Probes the Mailgun HTTP API for the configured sending domain. Mailgun
// returns 200 with domain metadata on success, 401/403 on bad/missing key,
// and 404 on unknown domain. No side effects — just GET /v3/{domain}.
async function checkMailgun(): Promise<SubsystemResult> {
  const apiKey = process.env.MAILGUN_API_KEY?.trim();
  const domain = process.env.MAILGUN_DOMAIN?.trim();

  if (!apiKey || !domain) {
    return { status: "not_configured" };
  }

  try {
    const basicAuth = Buffer.from(`api:${apiKey}`).toString("base64");
    const res = await fetch(`https://api.mailgun.net/v3/${domain}`, {
      method: "GET",
      headers: { Authorization: `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "connected" };
    return {
      status: "disconnected",
      error: `Mailgun returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      status: "disconnected",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const GET: APIRoute = async () => {
  const [stripe, email] = await Promise.all([checkStripe(), checkMailgun()]);

  if (stripe.status === "disconnected") {
    logger.error("health.stripe_check_failed", { error: stripe.error });
  }
  if (stripe.status === "not_configured") {
    logger.warn("health.check", { reason: "STRIPE_SECRET_KEY not configured" });
  }
  if (email.status === "disconnected") {
    logger.error("health.mailgun_check_failed", { error: email.error });
  }
  if (email.status === "not_configured") {
    logger.warn("health.check", {
      reason: "MAILGUN_API_KEY or MAILGUN_DOMAIN not configured",
    });
  }

  // A subsystem is healthy only when fully connected. "not_configured" counts
  // as unhealthy: in deployed envs these credentials are mandatory, and a
  // silently missing key is exactly the failure this endpoint must catch.
  const healthy = stripe.status === "connected" && email.status === "connected";
  const body: Record<string, unknown> = {
    status: healthy ? "ok" : "degraded",
    stripe: stripe.status,
    email: email.status,
  };
  if (stripe.error || email.error) {
    body.errors = {
      ...(stripe.error ? { stripe: stripe.error } : {}),
      ...(email.error ? { email: email.error } : {}),
    };
  }

  // Always 200: this path backs the Fly HTTP liveness check on a single-machine
  // app. Returning 503 here would make Fly pull the only VM out of rotation and
  // take the public site down when only a background subsystem (e.g. email) is
  // degraded. Consumers read `body.status` for readiness; the Slack worker
  // alerts whenever status !== "ok".
  return Response.json(body);
};

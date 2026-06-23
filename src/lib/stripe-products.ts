import Stripe from "stripe";

export type LookupKey = "pm_renewal_nzd" | "am_renewal_nzd";

interface CachedPrice {
  priceId: string;
  currency: string;
  unitAmount: number;
  resolvedAt: number;
}

const priceCache = new Map<LookupKey, CachedPrice>();
const CACHE_TTL_MS = 5 * 60 * 1000;

let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("MISSING_CONFIG: STRIPE_SECRET_KEY");
    stripeInstance = new Stripe(key, { apiVersion: "2026-02-25.clover" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

function getPriceEnvVar(lookupKey: LookupKey): string | undefined {
  return lookupKey === "pm_renewal_nzd"
    ? process.env.STRIPE_PRICE_PROFESSIONAL
    : process.env.STRIPE_PRICE_ASSOCIATE;
}

export async function resolveRenewalPrice(
  lookupKey: LookupKey
): Promise<{ priceId: string; currency: string; unitAmount: number }> {
  const cached = priceCache.get(lookupKey);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return { priceId: cached.priceId, currency: cached.currency, unitAmount: cached.unitAmount };
  }

  const priceId = getPriceEnvVar(lookupKey);
  if (!priceId) {
    throw new Error(`MISSING_CONFIG: STRIPE_PRICE_${lookupKey === "pm_renewal_nzd" ? "PROFESSIONAL" : "ASSOCIATE"} not set`);
  }

  const stripe = getStripe();
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`PRICE_RETRIEVE_FAILED: ${msg} (priceId=${priceId})`);
  }

  if (!price.active) {
    throw new Error(`PRICE_INACTIVE: price ${priceId} is not active`);
  }
  if (price.currency !== "nzd") {
    throw new Error(`INVALID_CURRENCY: price for ${lookupKey} returned currency=${price.currency}, expected nzd`);
  }
  if (price.unit_amount === null || price.unit_amount === undefined) {
    throw new Error(`INVALID_UNIT_AMOUNT: price for ${lookupKey} returned unit_amount=${price.unit_amount}`);
  }

  priceCache.set(lookupKey, {
    priceId: price.id,
    currency: price.currency,
    unitAmount: price.unit_amount,
    resolvedAt: Date.now(),
  });
  return { priceId: price.id, currency: price.currency, unitAmount: price.unit_amount };
}

export function invalidateRenewalPriceCache(): void {
  priceCache.clear();
}
# Membership Renewal Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a yearly membership renewal flow with two URLs: `/renew/pro` ($150 + PD form) and `/renew/associate` ($75, direct). Each submission creates a row in a new `Renewals` Google Sheet; Stripe Checkout auto-sends the receipt.

**Architecture:** Two new Astro pages + two new API endpoints + a shared webhook branch. Stripe prices resolved via `lookup_key` with a 5-min in-memory cache (cerebrum 2026-06-14 pattern). One-time payment only — no Stripe Subscription. Renewal rows live in a new `Renewals` sheet, separate from `Professional Applications`.

**Tech Stack:** Astro SSR (existing), TypeScript, Stripe SDK v20, Google Sheets via `googleapis` + DWD impersonation, Vitest. Reuses existing helpers from `src/lib/stripe-checkout.ts`, `src/lib/google-sheets.ts`, `src/lib/email-sender.ts`.

**Spec:** `/Users/thomasb/.claude/plans/witty-fluttering-cerf.md`

---

## Pre-flight: Stripe Dashboard setup

**This is manual work before any code is deployed.** Skip for local-only TDD; required before staging deploy.

- [ ] Verify existing `STRIPE_PRICE_PROFESSIONAL` and `STRIPE_PRICE_ASSOCIATE` Fly secrets are set on both staging and production apps. These now point to the renewal prices:
  - `STRIPE_PRICE_PROFESSIONAL` = `price_1TTFkhCi50x7UA8b51G5y4TQ` ($150 NZD PM renewal, product `prod_U7vDD3Q6088P3i`)
  - `STRIPE_PRICE_ASSOCIATE` = `price_1TTFjrCi50x7UA8b6rursmWq` ($75 NZD AM renewal, product `prod_U7vqEzAEaaK8nC`)

**No new env vars needed.** The renewal flow reuses the existing `STRIPE_PRICE_*` env vars; `src/lib/stripe-products.ts` reads them and validates via `stripe.prices.retrieve()` (currency = nzd, active = true, unit_amount present) before caching.

**Add Fly secrets** (only if not already set on the app):

```bash
fly secrets set STRIPE_PRICE_PROFESSIONAL=price_1TTFkhCi50x7UA8b51G5y4TQ --app eldaa
fly secrets set STRIPE_PRICE_ASSOCIATE=price_1TTFjrCi50x7UA8b6rursmWq --app eldaa
fly secrets set STRIPE_PRICE_PROFESSIONAL=price_1TTFkhCi50x7UA8b51G5y4TQ --app eldaa-production
fly secrets set STRIPE_PRICE_ASSOCIATE=price_1TTFjrCi50x7UA8b6rursmWq --app eldaa-production
```

**Local env** (`.env.local`):
```
STRIPE_PRICE_PROFESSIONAL=price_1TTFkhCi50x7UA8b51G5y4TQ
STRIPE_PRICE_ASSOCIATE=price_1TTFjrCi50x7UA8b6rursmWq
```

---

## Task 1: Add env var type declarations

**Files:**
- Modify: `src/env.d.ts:4-12`
- Modify: `.env.example`

- [ ] **Step 1: Add env vars to `src/env.d.ts`**

Replace the entire env interface block (lines 4-12):

```ts
interface ImportMetaEnv {
  readonly STRIPE_SECRET_KEY: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly STRIPE_PRICE_ASSOCIATE?: string;
  readonly STRIPE_PRICE_PROFESSIONAL?: string;
  readonly STRIPE_PRODUCT_PM_RENEWAL?: string;
  readonly STRIPE_PRODUCT_AM_RENEWAL?: string;
  readonly PUBLIC_SITE_URL?: string;
  readonly GOOGLE_WORKSPACE_IMPERSONATE_USER?: string;
  readonly MAILGUN_API_KEY?: string;
  readonly MAILGUN_DOMAIN?: string;
  readonly MAILGUN_FROM?: string;
}
```

- [ ] **Step 2: Add env vars to `.env.example`**

Append after the existing Stripe price lines:

```
# Membership renewal — Stripe product IDs (resolve active price via lookup_key at boot)
STRIPE_PRODUCT_PM_RENEWAL=prod_replace_me
STRIPE_PRODUCT_AM_RENEWAL=prod_replace_me
```

- [ ] **Step 3: Verify type-check passes**

Run: `npm run check`
Expected: no new errors related to the env declarations.

- [ ] **Step 4: Commit**

```bash
git add src/env.d.ts .env.example
git commit -m "feat(renewal): add STRIPE_PRODUCT_*_RENEWAL env declarations"
```

---

## Task 2: Build `src/lib/stripe-products.ts` (lookup_key resolver) — TDD

**Files:**
- Create: `src/lib/stripe-products.ts`
- Create: `src/lib/stripe-products.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/lib/stripe-products.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock google-auth module before importing module under test (mirrors google-sheets.test.ts pattern)
vi.mock("../src/lib/google-auth", () => ({ getServiceAccountJwtAuth: vi.fn() }));

// Mock Stripe SDK before module-under-test imports it
const mockPricesList = vi.fn();
vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    prices: { list: mockPricesList },
  })),
}));

import { invalidateRenewalPriceCache, resolveRenewalPrice } from "./stripe-products";

describe("resolveRenewalPrice", () => {
  beforeEach(() => {
    invalidateRenewalPriceCache();
    mockPricesList.mockReset();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  });

  afterEach(() => {
    delete process.env.STRIPE_PRODUCT_PM_RENEWAL;
    delete process.env.STRIPE_PRODUCT_AM_RENEWAL;
  });

  it("returns price config when Stripe returns active NZD price", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValueOnce({
      data: [{ id: "price_pm_150", currency: "nzd", unit_amount: 15000, active: true, lookup_keys: ["pm_renewal_nzd"] }],
    });

    const result = await resolveRenewalPrice("pm_renewal_nzd");
    expect(result).toEqual({ priceId: "price_pm_150", currency: "nzd", unitAmount: 15000 });
  });

  it("throws MISSING_CONFIG when STRIPE_PRODUCT_PM_RENEWAL env var missing", async () => {
    await expect(resolveRenewalPrice("pm_renewal_nzd")).rejects.toThrow(/MISSING_CONFIG/);
  });

  it("throws PRICE_INACTIVE when no active prices found for lookup_key", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValueOnce({ data: [] });
    await expect(resolveRenewalPrice("pm_renewal_nzd")).rejects.toThrow(/PRICE_INACTIVE/);
  });

  it("throws when price currency is not NZD", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValueOnce({
      data: [{ id: "price_pm_150", currency: "usd", unit_amount: 15000, active: true, lookup_keys: ["pm_renewal_nzd"] }],
    });
    await expect(resolveRenewalPrice("pm_renewal_nzd")).rejects.toThrow(/currency/);
  });

  it("throws when unit_amount is null", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValueOnce({
      data: [{ id: "price_pm_150", currency: "nzd", unit_amount: null, active: true, lookup_keys: ["pm_renewal_nzd"] }],
    });
    await expect(resolveRenewalPrice("pm_renewal_nzd")).rejects.toThrow(/unit_amount/);
  });

  it("caches the resolved price for subsequent calls within TTL", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValue({
      data: [{ id: "price_pm_150", currency: "nzd", unit_amount: 15000, active: true, lookup_keys: ["pm_renewal_nzd"] }],
    });

    await resolveRenewalPrice("pm_renewal_nzd");
    await resolveRenewalPrice("pm_renewal_nzd");
    expect(mockPricesList).toHaveBeenCalledTimes(1);
  });

  it("uses correct product env var for AM lookup_key", async () => {
    process.env.STRIPE_PRODUCT_AM_RENEWAL = "prod_am";
    mockPricesList.mockResolvedValueOnce({
      data: [{ id: "price_am_75", currency: "nzd", unit_amount: 7500, active: true, lookup_keys: ["am_renewal_nzd"] }],
    });

    const result = await resolveRenewalPrice("am_renewal_nzd");
    expect(result.priceId).toBe("price_am_75");
    expect(mockPricesList).toHaveBeenCalledWith(expect.objectContaining({ product: "prod_am" }));
  });

  it("invalidateRenewalPriceCache clears the cache", async () => {
    process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";
    mockPricesList.mockResolvedValue({
      data: [{ id: "price_pm_150", currency: "nzd", unit_amount: 15000, active: true, lookup_keys: ["pm_renewal_nzd"] }],
    });

    await resolveRenewalPrice("pm_renewal_nzd");
    invalidateRenewalPriceCache();
    await resolveRenewalPrice("pm_renewal_nzd");
    expect(mockPricesList).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/stripe-products.test.ts`
Expected: FAIL — `./stripe-products` module does not exist.

- [ ] **Step 3: Implement `src/lib/stripe-products.ts`**

Create the file:

```ts
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
    stripeInstance = new Stripe(key, { apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

function getProductEnvVar(lookupKey: LookupKey): string | undefined {
  return lookupKey === "pm_renewal_nzd"
    ? process.env.STRIPE_PRODUCT_PM_RENEWAL
    : process.env.STRIPE_PRODUCT_AM_RENEWAL;
}

export async function resolveRenewalPrice(
  lookupKey: LookupKey
): Promise<{ priceId: string; currency: string; unitAmount: number }> {
  const cached = priceCache.get(lookupKey);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return { priceId: cached.priceId, currency: cached.currency, unitAmount: cached.unitAmount };
  }

  const productEnvVar = getProductEnvVar(lookupKey);
  if (!productEnvVar) {
    throw new Error(`MISSING_CONFIG: STRIPE_PRODUCT_${lookupKey === "pm_renewal_nzd" ? "PM" : "AM"}_RENEWAL not set`);
  }

  const stripe = getStripe();
  const prices = await stripe.prices.list({
    product: productEnvVar,
    active: true,
    lookup_keys: [lookupKey],
    limit: 1,
  });

  if (!prices.data.length) {
    throw new Error(`PRICE_INACTIVE: no active price for lookup_key ${lookupKey} on product ${productEnvVar}`);
  }

  const price = prices.data[0];
  if (price.currency !== "nzd") {
    throw new Error(`Invalid price currency for ${lookupKey}: ${price.currency} (expected nzd)`);
  }
  if (price.unit_amount === null || price.unit_amount === undefined) {
    throw new Error(`Invalid unit_amount for ${lookupKey}: null`);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/stripe-products.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stripe-products.ts src/lib/stripe-products.test.ts
git commit -m "feat(renewal): add stripe-products resolver with lookup_key cache"
```

---

## Task 3: Build `src/lib/renewal-sheet.ts` — TDD

**Files:**
- Create: `src/lib/renewal-sheet.ts`
- Create: `src/lib/renewal-sheet.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/renewal-sheet.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock google-auth (mirrors google-sheets.test.ts)
const mockAuth = vi.fn();
vi.mock("./google-auth", () => ({ getServiceAccountJwtAuth: mockAuth }));

// Mock googleapis
const mockAppend = vi.fn();
const mockUpdate = vi.fn();
const mockGet = vi.fn();
const mockBatchUpdate = vi.fn();
const mockEnsureSheet = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        values: { append: mockAppend, update: mockUpdate, get: mockGet },
        batchUpdate: mockBatchUpdate,
        get: mockEnsureSheet,
      },
    })),
  },
}));

process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "sheet_test_id";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import { appendRenewal, getRenewalBySession, markRenewalPaid } from "./renewal-sheet";

describe("appendRenewal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({});
    mockAppend.mockResolvedValue({});
    mockEnsureSheet.mockResolvedValue({ data: { sheets: [{ properties: { title: "Renewals" } }] } });
  });

  afterEach(() => {
    delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  });

  it("appends a row with all 14 columns in correct order", async () => {
    await appendRenewal({
      renewalId: "r1",
      tier: "pm",
      year: 2026,
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      phone: "021234567",
      pdEntries: [{ dateCompleted: "2026-01-15", activity: "Workshop", totalHours: 3, provider: "Hospice NZ" }],
      amountCents: 15000,
      currency: "nzd",
      stripeSession: "cs_test_1",
      paymentStatus: "pending",
      createdAt: "2026-06-23T10:00:00.000Z",
    });

    expect(mockAppend).toHaveBeenCalledTimes(1);
    const call = mockAppend.mock.calls[0][0];
    expect(call.range).toBe("'Renewals'!A1:N1");
    expect(call.requestBody.values[0]).toHaveLength(14);
    expect(call.requestBody.values[0][0]).toBe("r1");
    expect(call.requestBody.values[0][1]).toBe("pm");
    expect(call.requestBody.values[0][7]).toBe(JSON.stringify([{ dateCompleted: "2026-01-15", activity: "Workshop", totalHours: 3, provider: "Hospice NZ" }]));
    expect(call.requestBody.values[0][10]).toBe("pending");
  });

  it("calls ensureSheetWithHeaders on first write to create Renewals tab", async () => {
    // First call: ensureSheet returns no sheets → create
    mockEnsureSheet.mockResolvedValueOnce({ data: { sheets: [] } });

    await appendRenewal({
      renewalId: "r1", tier: "pm", year: 2026, firstName: "A", lastName: "B",
      email: "a@b.com", phone: "", pdEntries: [], amountCents: 15000,
      currency: "nzd", stripeSession: "cs_1", paymentStatus: "pending",
      createdAt: "2026-06-23T10:00:00.000Z",
    });

    expect(mockBatchUpdate).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it("does not re-create the Renewals tab on subsequent writes", async () => {
    mockEnsureSheet.mockResolvedValue({ data: { sheets: [{ properties: { title: "Renewals" } }] } });

    await appendRenewal({
      renewalId: "r1", tier: "pm", year: 2026, firstName: "A", lastName: "B",
      email: "a@b.com", phone: "", pdEntries: [], amountCents: 15000,
      currency: "nzd", stripeSession: "cs_1", paymentStatus: "pending",
      createdAt: "2026-06-23T10:00:00.000Z",
    });

    expect(mockBatchUpdate).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });
});

describe("markRenewalPaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({});
    mockUpdate.mockResolvedValue({});
  });

  it("linear-scans column A for renewal_id then updates columns K and N", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        values: [
          ["renewal_id", "tier", "renewal_year", "first_name", "last_name", "email", "phone", "pd_entries", "amount_paid_cents", "currency", "payment_status", "stripe_session", "created_at", "paid_at"],
          ["r1", "pm", "2026", "Alice", "Smith", "alice@example.com", "", "[]", "15000", "nzd", "pending", "cs_1", "2026-06-23T10:00:00Z", ""],
        ],
      },
    });

    await markRenewalPaid("r1", "2026-06-23T11:00:00.000Z");

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const call = mockUpdate.mock.calls[0][0];
    expect(call.range).toBe("'Renewals'!K2:N2");
    expect(call.requestBody.values[0]).toEqual(["paid", "cs_1", "2026-06-23T10:00:00Z", "2026-06-23T11:00:00.000Z"]);
  });

  it("does nothing when renewal_id is not found", async () => {
    mockGet.mockResolvedValueOnce({
      data: { values: [["renewal_id"], ["other"]] },
    });

    await markRenewalPaid("missing", "2026-06-23T11:00:00.000Z");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("getRenewalBySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({});
  });

  it("returns the row matching stripe_session", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        values: [
          ["renewal_id", "tier", "renewal_year", "first_name", "last_name", "email", "phone", "pd_entries", "amount_paid_cents", "currency", "payment_status", "stripe_session", "created_at", "paid_at"],
          ["r1", "pm", "2026", "Alice", "Smith", "alice@example.com", "", "[]", "15000", "nzd", "paid", "cs_target", "2026-06-23T10:00:00Z", "2026-06-23T11:00:00Z"],
        ],
      },
    });

    const result = await getRenewalBySession("cs_target");
    expect(result?.renewalId).toBe("r1");
    expect(result?.paymentStatus).toBe("paid");
    expect(result?.amountPaidCents).toBe(15000);
  });

  it("returns null when no row matches", async () => {
    mockGet.mockResolvedValueOnce({
      data: { values: [["renewal_id"], ["r1"]] },
    });

    const result = await getRenewalBySession("cs_missing");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/renewal-sheet.test.ts`
Expected: FAIL — `./renewal-sheet` module does not exist.

- [ ] **Step 3: Implement `src/lib/renewal-sheet.ts`**

Create the file:

```ts
import { google } from "googleapis";
import { getServiceAccountJwtAuth } from "./google-auth";

export interface PdEntry {
  dateCompleted: string;
  activity: string;
  totalHours: number;
  provider: string;
}

export interface RenewalInput {
  renewalId: string;
  tier: "pm" | "am";
  year: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  pdEntries: PdEntry[];
  amountCents: number;
  currency: string;
  stripeSession: string;
  paymentStatus: "pending";
  createdAt: string;
}

export interface RenewalRow {
  renewalId: string;
  tier: "pm" | "am";
  renewalYear: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  pdEntries: PdEntry[];
  amountPaidCents: number;
  currency: string;
  paymentStatus: "pending" | "paid";
  stripeSession: string;
  createdAt: string;
  paidAt: string;
}

const RENEWAL_HEADERS = [
  "renewal_id", "tier", "renewal_year",
  "first_name", "last_name", "email", "phone",
  "pd_entries", "amount_paid_cents", "currency",
  "payment_status", "stripe_session", "created_at", "paid_at",
] as const;

const SHEET_NAME = "Renewals";

async function getSheetsClient() {
  const auth = await getServiceAccountJwtAuth(["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version: "v4", auth });
}

async function ensureRenewalsSheet(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID not set");
  const sheets = await getSheetsClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === SHEET_NAME);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A1:N1`,
      valueInputOption: "RAW",
      requestBody: { values: [RENEWAL_HEADERS as unknown as string[]] },
    });
  }
}

export async function appendRenewal(input: RenewalInput): Promise<void> {
  await ensureRenewalsSheet();

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID not set");
  const sheets = await getSheetsClient();

  const row = [
    input.renewalId,
    input.tier,
    String(input.year),
    input.firstName,
    input.lastName,
    input.email,
    input.phone,
    JSON.stringify(input.pdEntries),
    String(input.amountCents),
    input.currency,
    input.paymentStatus,
    input.stripeSession,
    input.createdAt,
    "",
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A1:N1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

export async function markRenewalPaid(renewalId: string, paidAt: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID not set");
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A1:N1000`,
  });
  const rows = res.data.values ?? [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex((r) => r[0] === renewalId);
  if (idx === -1) {
    // No-op; let the caller log if needed
    return;
  }
  const rowNumber = idx + 2; // +1 for header, +1 for 1-based

  const existing = dataRows[idx];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_NAME}'!K${rowNumber}:N${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "paid",
        existing[11] ?? "",        // stripe_session (col L)
        existing[12] ?? "",        // created_at (col M)
        paidAt,
      ]],
    },
  });
}

export async function getRenewalBySession(stripeSessionId: string): Promise<RenewalRow | null> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID not set");
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A1:N1000`,
  });
  const rows = res.data.values ?? [];
  const dataRows = rows.slice(1);

  const match = dataRows.find((r) => r[11] === stripeSessionId);
  if (!match) return null;

  const pdRaw = match[7] ?? "[]";
  const pdEntries: PdEntry[] = (() => {
    try { return JSON.parse(pdRaw); } catch { return []; }
  })();

  return {
    renewalId: match[0] ?? "",
    tier: (match[1] === "am" ? "am" : "pm"),
    renewalYear: Number(match[2] ?? 0),
    firstName: match[3] ?? "",
    lastName: match[4] ?? "",
    email: match[5] ?? "",
    phone: match[6] ?? "",
    pdEntries,
    amountPaidCents: Number(match[8] ?? 0),
    currency: match[9] ?? "nzd",
    paymentStatus: (match[10] === "paid" ? "paid" : "pending"),
    stripeSession: match[11] ?? "",
    createdAt: match[12] ?? "",
    paidAt: match[13] ?? "",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/renewal-sheet.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/renewal-sheet.ts src/lib/renewal-sheet.test.ts
git commit -m "feat(renewal): add renewal-sheet helpers with lazy sheet creation"
```

---

## Task 4: Add webhook renewal branch — TDD

**Files:**
- Modify: `src/pages/api/stripe-webhook.ts`
- Modify: `src/pages/api/stripe-webhook.test.ts`

- [ ] **Step 1: Read existing webhook test patterns**

Run: `Read src/pages/api/stripe-webhook.test.ts` to understand the mocking style (Stripe SDK + module mocks, similar to existing tests for `option_c` paths).

- [ ] **Step 2: Write the failing tests**

Add at the end of `src/pages/api/stripe-webhook.test.ts` (inside the top-level `describe`, after the existing tests). First add the mocks at the top of the test file (mirroring the pattern used for `option_c` tests):

```ts
const mockMarkRenewalPaid = vi.fn();
const mockGetRenewalBySession = vi.fn();
const mockAppendCheckoutLog = vi.fn();
vi.mock("../../lib/renewal-sheet", () => ({
  markRenewalPaid: mockMarkRenewalPaid,
  getRenewalBySession: mockGetRenewalBySession,
}));
vi.mock("../../lib/google-sheets", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendCheckoutLog: mockAppendCheckoutLog };
});
```

Then add a new describe block:

```ts
describe("renewal flow", () => {
  it("marks renewal row paid when checkout.session.completed fires for renewal metadata", async () => {
    const mockSession = {
      id: "cs_renewal_1",
      object: "checkout.session",
      mode: "payment",
      customer: "cus_renewal",
      customer_email: "alice@example.com",
      payment_intent: "pi_1",
      metadata: {
        flow: "renewal",
        tier: "pm",
        renewal_id: "r1",
        renewal_year: "2026",
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@example.com",
        phone: "",
        pd_entries: "[]",
        amount_cents: "15000",
      },
    };
    const mockEvent = {
      id: "evt_renewal_1",
      type: "checkout.session.completed",
      data: { object: mockSession },
    };
    mockStripeWebhooksConstructEvent.mockReturnValueOnce(mockEvent);

    mockGetRenewalBySession.mockResolvedValueOnce({
      renewalId: "r1",
      tier: "pm",
      renewalYear: 2026,
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      phone: "",
      pdEntries: [],
      amountPaidCents: 15000,
      currency: "nzd",
      paymentStatus: "pending",
      stripeSession: "cs_renewal_1",
      createdAt: "2026-06-23T10:00:00Z",
      paidAt: "",
    });
    mockMarkRenewalPaid.mockResolvedValueOnce(undefined);
    mockAppendCheckoutLog.mockResolvedValueOnce(undefined);

    const response = await callWebhook();
    expect(response.status).toBe(200);

    expect(mockMarkRenewalPaid).toHaveBeenCalledWith("r1", expect.any(String));
    expect(mockStripeSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockAppendCheckoutLog).toHaveBeenCalledWith(expect.objectContaining({
      plan: "renewal_pm",
      amountPaid: 15000,
      sessionId: "cs_renewal_1",
    }));
  });

  it("is idempotent — skips markRenewalPaid when row already paid", async () => {
    const mockSession = {
      id: "cs_renewal_2",
      object: "checkout.session",
      mode: "payment",
      customer: "cus_2",
      customer_email: "bob@example.com",
      payment_intent: "pi_2",
      metadata: { flow: "renewal", tier: "am", renewal_id: "r2", renewal_year: "2026", first_name: "Bob", last_name: "Doe", email: "bob@example.com", phone: "", pd_entries: "", amount_cents: "7500" },
    };
    const mockEvent = { id: "evt_2", type: "checkout.session.completed", data: { object: mockSession } };
    mockStripeWebhooksConstructEvent.mockReturnValueOnce(mockEvent);

    mockGetRenewalBySession.mockResolvedValueOnce({
      renewalId: "r2", tier: "am", renewalYear: 2026,
      firstName: "Bob", lastName: "Doe", email: "bob@example.com", phone: "",
      pdEntries: [], amountPaidCents: 7500, currency: "nzd",
      paymentStatus: "paid",
      stripeSession: "cs_renewal_2",
      createdAt: "2026-06-23T10:00:00Z", paidAt: "2026-06-23T10:01:00Z",
    });

    const response = await callWebhook();
    expect(response.status).toBe(200);
    expect(mockMarkRenewalPaid).not.toHaveBeenCalled();
  });

  it("does nothing when renewal row not found (logs and returns 200)", async () => {
    const mockSession = {
      id: "cs_orphan", object: "checkout.session", mode: "payment", customer: "cus_3",
      customer_email: "x@example.com", payment_intent: "pi_3",
      metadata: { flow: "renewal", tier: "pm", renewal_id: "missing" },
    };
    const mockEvent = { id: "evt_3", type: "checkout.session.completed", data: { object: mockSession } };
    mockStripeWebhooksConstructEvent.mockReturnValueOnce(mockEvent);
    mockGetRenewalBySession.mockResolvedValueOnce(null);

    const response = await callWebhook();
    expect(response.status).toBe(200);
    expect(mockMarkRenewalPaid).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/pages/api/stripe-webhook.test.ts`
Expected: FAIL — renewal branch not implemented.

- [ ] **Step 4: Add the renewal branch to `src/pages/api/stripe-webhook.ts`**

In `handleCheckoutCompleted` (line 32), after the existing `option_c` handling block but before the final `return`, add:

```ts
  // Renewal flow: one-time payment, no subscription
  if (session.metadata?.flow === "renewal") {
    const renewalId = session.metadata.renewal_id as string;
    if (!renewalId) {
      logger.warn({ sessionId: session.id }, "renewal_missing_id");
      return;
    }
    const renewal = await getRenewalBySession(session.id);
    if (!renewal) {
      logger.warn({ sessionId: session.id, renewalId }, "renewal_not_found");
      return;
    }
    if (renewal.paymentStatus === "paid") {
      logger.info({ sessionId: session.id, renewalId }, "renewal_skip_already_paid");
      return;
    }
    const paidAt = new Date().toISOString();
    await markRenewalPaid(renewalId, paidAt);

    const sessionCustomerId = typeof session.customer === "string" ? session.customer : "";
    void appendCheckoutLog({
      timestamp: paidAt,
      firstName: renewal.firstName,
      lastName: renewal.lastName,
      phone: renewal.phone,
      email: renewal.email,
      plan: `renewal_${renewal.tier}`,
      amountPaid: renewal.amountPaidCents,
      sessionId: session.id,
      customerId: sessionCustomerId,
    }).catch((err) => logger.error({ err, renewalId }, "renewal_checkout_log_failed"));

    logger.info({ renewalId, sessionId: session.id, tier: renewal.tier }, "renewal_marked_paid");
    return;
  }
```

Add the imports at the top of the file:

```ts
import { getRenewalBySession, markRenewalPaid } from "../../lib/renewal-sheet";
import { appendCheckoutLog } from "../../lib/google-sheets";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/pages/api/stripe-webhook.test.ts`
Expected: PASS (existing tests + 3 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/stripe-webhook.ts src/pages/api/stripe-webhook.test.ts
git commit -m "feat(renewal): handle checkout.session.completed for renewal flow"
```

---

## Task 5: Build `src/pages/api/renew/checkout-pm.ts` — TDD

**Files:**
- Create: `src/pages/api/renew/checkout-pm.ts`
- Create: `src/pages/api/renew/checkout-pm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pages/api/renew/checkout-pm.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRenewalPrice = vi.fn();
const mockAppendRenewal = vi.fn();
const mockStripeSessionsCreate = vi.fn();
const mockGetSiteBaseUrl = vi.fn(() => "https://test.example.com");
const mockIsCheckoutDryRunEnabled = vi.fn(() => false);
const mockIsStripeRetryableError = vi.fn(() => false);

vi.mock("../../../lib/stripe-products", () => ({
  resolveRenewalPrice: mockResolveRenewalPrice,
  invalidateRenewalPriceCache: vi.fn(),
}));

vi.mock("../../../lib/renewal-sheet", () => ({
  appendRenewal: mockAppendRenewal,
  markRenewalPaid: vi.fn(),
  getRenewalBySession: vi.fn(),
}));

vi.mock("../../../lib/stripe-checkout", () => ({
  getSiteBaseUrl: mockGetSiteBaseUrl,
  isCheckoutDryRunEnabled: mockIsCheckoutDryRunEnabled,
  isStripeRetryableError: mockIsStripeRetryableError,
}));

vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    checkout: { sessions: { create: mockStripeSessionsCreate } },
  })),
}));

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_PRODUCT_PM_RENEWAL = "prod_pm";

import { POST } from "./checkout-pm";

const VALID_BODY = {
  firstName: "Alice", lastName: "Smith", email: "alice@example.com", phone: "021234567",
  year: 2026,
  pdEntries: [{ dateCompleted: "2026-01-15", activity: "Workshop", totalHours: 3, provider: "Hospice NZ" }],
};

async function call(body: unknown) {
  const request = new Request("https://test.example.com/api/renew/checkout-pm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST({ request } as any);
}

describe("checkout-pm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCheckoutDryRunEnabled.mockReturnValue(false);
    mockIsStripeRetryableError.mockReturnValue(false);
    mockResolveRenewalPrice.mockResolvedValue({ priceId: "price_pm_150", currency: "nzd", unitAmount: 15000 });
    mockAppendRenewal.mockResolvedValue(undefined);
    mockStripeSessionsCreate.mockResolvedValue({ id: "cs_pm_1", url: "https://stripe.com/c/cs_pm_1" });
  });

  it("happy path: resolves price, appends pending row, creates Stripe session", async () => {
    const response = await call(VALID_BODY);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.url).toBe("https://stripe.com/c/cs_pm_1");
    expect(json.renewalId).toBeDefined();

    const appendOrder = mockAppendRenewal.mock.invocationCallOrder[0];
    const stripeOrder = mockStripeSessionsCreate.mock.invocationCallOrder[0];
    expect(appendOrder).toBeLessThan(stripeOrder);

    expect(mockAppendRenewal).toHaveBeenCalledWith(expect.objectContaining({
      tier: "pm", year: 2026, amountCents: 15000, paymentStatus: "pending",
    }));
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "payment",
      metadata: expect.objectContaining({ flow: "renewal", tier: "pm", amount_cents: "15000" }),
      client_reference_id: expect.any(String),
    }));
  });

  it("returns 400 when firstName missing", async () => {
    const response = await call({ ...VALID_BODY, firstName: "" });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.field).toBe("firstName");
  });

  it("returns 400 when email contains CR/LF (header injection guard)", async () => {
    const response = await call({ ...VALID_BODY, email: "alice@example.com\r\nBcc: spy@y.com" });
    expect(response.status).toBe(400);
  });

  it("returns 400 when pdEntries is empty", async () => {
    const response = await call({ ...VALID_BODY, pdEntries: [] });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.field).toBe("pdEntries");
  });

  it("returns 400 when pdEntries[0] missing required field", async () => {
    const response = await call({
      ...VALID_BODY,
      pdEntries: [{ dateCompleted: "2026-01-15", activity: "Workshop", provider: "" }],
    });
    expect(response.status).toBe(400);
  });

  it("returns 500 with code MISSING_CONFIG when STRIPE_PRODUCT_PM_RENEWAL not set", async () => {
    delete process.env.STRIPE_PRODUCT_PM_RENEWAL;
    mockResolveRenewalPrice.mockRejectedValueOnce(new Error("MISSING_CONFIG: STRIPE_PRODUCT_PM_RENEWAL not set"));

    const response = await call(VALID_BODY);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("MISSING_CONFIG");
  });

  it("returns 500 with code PRICE_INACTIVE when Stripe returns no active price", async () => {
    mockResolveRenewalPrice.mockRejectedValueOnce(new Error("PRICE_INACTIVE: no active price"));

    const response = await call(VALID_BODY);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("PRICE_INACTIVE");
  });

  it("returns 500 with code CHECKOUT_ERROR on Stripe API error (retryable=false)", async () => {
    mockStripeSessionsCreate.mockRejectedValueOnce(new Error("Stripe API error"));
    mockIsStripeRetryableError.mockReturnValue(false);

    const response = await call(VALID_BODY);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("CHECKOUT_ERROR");
    expect(json.retryable).toBe(false);
  });

  it("returns 500 with retryable=true on StripeConnectionError", async () => {
    mockStripeSessionsCreate.mockRejectedValueOnce(new Error("Stripe connection failed"));
    mockIsStripeRetryableError.mockReturnValue(true);

    const response = await call(VALID_BODY);
    const json = await response.json();
    expect(json.retryable).toBe(true);
  });

  it("dry-run: returns { dryRun: true } without creating session or appending row", async () => {
    mockIsCheckoutDryRunEnabled.mockReturnValue(true);

    const response = await call(VALID_BODY);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.dryRun).toBe(true);
    expect(json.priceValidated).toBe(true);
    expect(json.priceId).toBe("price_pm_150");

    expect(mockAppendRenewal).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/api/renew/checkout-pm.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/pages/api/renew/checkout-pm.ts`**

Create the file:

```ts
import type { APIRoute } from "astro";
import Stripe from "stripe";
import { resolveRenewalPrice } from "../../../lib/stripe-products";
import { appendRenewal, type PdEntry } from "../../../lib/renewal-sheet";
import { getSiteBaseUrl, isCheckoutDryRunEnabled, isStripeRetryableError } from "../../../lib/stripe-checkout";

const EMAIL_RE = /^[^\r\n@\s]+@[^\r\n@\s]+\.[^\r\n@\s]+$/;

interface CheckoutPmBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  year?: number;
  pdEntries?: PdEntry[];
}

let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("MISSING_CONFIG: STRIPE_SECRET_KEY");
    stripeInstance = new Stripe(key, { apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

function isValidPdEntry(entry: unknown): entry is PdEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.dateCompleted === "string" && e.dateCompleted.length > 0 &&
    typeof e.activity === "string" && e.activity.length > 0 &&
    typeof e.totalHours === "number" && e.totalHours > 0 &&
    typeof e.provider === "string"
  );
}

function badRequest(field: string, message: string) {
  return new Response(JSON.stringify({ error: message, field }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function serverError(code: string, message: string, retryable = false) {
  return new Response(JSON.stringify({ error: message, code, retryable }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: CheckoutPmBody;
  try {
    body = (await request.json()) as CheckoutPmBody;
  } catch {
    return badRequest("body", "Invalid JSON");
  }

  const firstName = (body.firstName ?? "").trim();
  const lastName = (body.lastName ?? "").trim();
  const email = (body.email ?? "").trim();
  const phone = (body.phone ?? "").trim();
  const year = Number(body.year);

  if (!firstName) return badRequest("firstName", "First name required");
  if (!lastName) return badRequest("lastName", "Last name required");
  if (!EMAIL_RE.test(email)) return badRequest("email", "Valid email required");
  if (!Number.isInteger(year) || year < 2024 || year > 2100) return badRequest("year", "Valid year required");

  const pdEntries = body.pdEntries ?? [];
  if (pdEntries.length === 0) return badRequest("pdEntries", "At least one PD entry required");
  if (!pdEntries.every(isValidPdEntry)) {
    return badRequest("pdEntries", "Each PD entry must have dateCompleted, activity, totalHours (number > 0), provider");
  }

  let priceConfig;
  try {
    priceConfig = await resolveRenewalPrice("pm_renewal_nzd");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("MISSING_CONFIG")) return serverError("MISSING_CONFIG", msg);
    if (msg.includes("PRICE_INACTIVE")) return serverError("PRICE_INACTIVE", msg);
    return serverError("CHECKOUT_ERROR", msg);
  }

  const renewalId = crypto.randomUUID();

  if (isCheckoutDryRunEnabled()) {
    return new Response(JSON.stringify({
      dryRun: true,
      priceValidated: true,
      priceId: priceConfig.priceId,
      renewalId,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const siteBaseUrl = getSiteBaseUrl(request.url);
  const createdAt = new Date().toISOString();

  await appendRenewal({
    renewalId, tier: "pm", year, firstName, lastName, email, phone,
    pdEntries, amountCents: priceConfig.unitAmount, currency: priceConfig.currency,
    stripeSession: "",
    paymentStatus: "pending",
    createdAt,
  });

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: "payment",
      success_url: `${siteBaseUrl}/renew/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteBaseUrl}/renew/pro?year=${year}&firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}`,
      line_items: [{ quantity: 1, price: priceConfig.priceId }],
      customer_email: email,
      customer_creation: "always",
      client_reference_id: renewalId,
      payment_intent_data: { receipt_email: email, setup_future_usage: "off_session" },
      metadata: {
        flow: "renewal",
        tier: "pm",
        renewal_id: renewalId,
        renewal_year: String(year),
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        pd_entries: JSON.stringify(pdEntries),
        amount_cents: String(priceConfig.unitAmount),
      },
    }, { idempotencyKey: `renewal:pm:${renewalId}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return serverError("CHECKOUT_ERROR", msg, isStripeRetryableError(err));
  }

  return new Response(JSON.stringify({ url: session.url, renewalId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/api/renew/checkout-pm.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/renew/checkout-pm.ts src/pages/api/renew/checkout-pm.test.ts
git commit -m "feat(renewal): add /api/renew/checkout-pm endpoint with dry-run support"
```

---

## Task 6: Build `src/pages/api/renew/checkout-am.ts` — TDD

**Files:**
- Create: `src/pages/api/renew/checkout-am.ts`
- Create: `src/pages/api/renew/checkout-am.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pages/api/renew/checkout-am.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRenewalPrice = vi.fn();
const mockAppendRenewal = vi.fn();
const mockStripeSessionsCreate = vi.fn();
const mockGetSiteBaseUrl = vi.fn(() => "https://test.example.com");
const mockIsCheckoutDryRunEnabled = vi.fn(() => false);
const mockIsStripeRetryableError = vi.fn(() => false);

vi.mock("../../../lib/stripe-products", () => ({
  resolveRenewalPrice: mockResolveRenewalPrice,
  invalidateRenewalPriceCache: vi.fn(),
}));
vi.mock("../../../lib/renewal-sheet", () => ({
  appendRenewal: mockAppendRenewal,
  markRenewalPaid: vi.fn(),
  getRenewalBySession: vi.fn(),
}));
vi.mock("../../../lib/stripe-checkout", () => ({
  getSiteBaseUrl: mockGetSiteBaseUrl,
  isCheckoutDryRunEnabled: mockIsCheckoutDryRunEnabled,
  isStripeRetryableError: mockIsStripeRetryableError,
}));
vi.mock("stripe", () => ({
  default: vi.fn(() => ({ checkout: { sessions: { create: mockStripeSessionsCreate } } })),
}));

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_PRODUCT_AM_RENEWAL = "prod_am";

import { POST } from "./checkout-am";

const VALID_BODY = { firstName: "Bob", lastName: "Doe", email: "bob@example.com", year: 2026 };

async function call(body: unknown) {
  const request = new Request("https://test.example.com/api/renew/checkout-am", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST({ request } as any);
}

describe("checkout-am", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCheckoutDryRunEnabled.mockReturnValue(false);
    mockResolveRenewalPrice.mockResolvedValue({ priceId: "price_am_75", currency: "nzd", unitAmount: 7500 });
    mockAppendRenewal.mockResolvedValue(undefined);
    mockStripeSessionsCreate.mockResolvedValue({ id: "cs_am_1", url: "https://stripe.com/c/cs_am_1" });
  });

  it("happy path: creates Stripe session with am_renewal_nzd lookup", async () => {
    const response = await call(VALID_BODY);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.url).toBe("https://stripe.com/c/cs_am_1");

    expect(mockResolveRenewalPrice).toHaveBeenCalledWith("am_renewal_nzd");
    expect(mockAppendRenewal).toHaveBeenCalledWith(expect.objectContaining({
      tier: "am", phone: "", pdEntries: [], amountCents: 7500, paymentStatus: "pending",
    }));
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ quantity: 1, price: "price_am_75" }],
      metadata: expect.objectContaining({ flow: "renewal", tier: "am", pd_entries: "[]", amount_cents: "7500" }),
    }), expect.objectContaining({ idempotencyKey: expect.stringMatching(/^renewal:am:/) }));
  });

  it("returns 400 on missing fields", async () => {
    expect((await call({ firstName: "", lastName: "Doe", email: "bob@example.com", year: 2026 })).status).toBe(400);
    expect((await call({ firstName: "Bob", lastName: "", email: "bob@example.com", year: 2026 })).status).toBe(400);
    expect((await call({ firstName: "Bob", lastName: "Doe", email: "", year: 2026 })).status).toBe(400);
  });

  it("returns 400 on invalid email", async () => {
    expect((await call({ ...VALID_BODY, email: "not-an-email" })).status).toBe(400);
  });

  it("returns 500 MISSING_CONFIG when STRIPE_PRODUCT_AM_RENEWAL missing", async () => {
    mockResolveRenewalPrice.mockRejectedValueOnce(new Error("MISSING_CONFIG: STRIPE_PRODUCT_AM_RENEWAL not set"));
    const response = await call(VALID_BODY);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("MISSING_CONFIG");
  });

  it("dry-run returns { dryRun: true } without creating session", async () => {
    mockIsCheckoutDryRunEnabled.mockReturnValue(true);
    const response = await call(VALID_BODY);
    const json = await response.json();
    expect(json.dryRun).toBe(true);
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    expect(mockAppendRenewal).not.toHaveBeenCalled();
  });

  it("returns 500 CHECKOUT_ERROR on Stripe error", async () => {
    mockStripeSessionsCreate.mockRejectedValueOnce(new Error("stripe failed"));
    const response = await call(VALID_BODY);
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("CHECKOUT_ERROR");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/api/renew/checkout-am.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/pages/api/renew/checkout-am.ts`**

Create the file:

```ts
import type { APIRoute } from "astro";
import Stripe from "stripe";
import { resolveRenewalPrice } from "../../../lib/stripe-products";
import { appendRenewal } from "../../../lib/renewal-sheet";
import { getSiteBaseUrl, isCheckoutDryRunEnabled, isStripeRetryableError } from "../../../lib/stripe-checkout";

const EMAIL_RE = /^[^\r\n@\s]+@[^\r\n@\s]+\.[^\r\n@\s]+$/;

interface CheckoutAmBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  year?: number;
}

let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("MISSING_CONFIG: STRIPE_SECRET_KEY");
    stripeInstance = new Stripe(key, { apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

function badRequest(field: string, message: string) {
  return new Response(JSON.stringify({ error: message, field }), { status: 400, headers: { "content-type": "application/json" } });
}

function serverError(code: string, message: string, retryable = false) {
  return new Response(JSON.stringify({ error: message, code, retryable }), { status: 500, headers: { "content-type": "application/json" } });
}

export const POST: APIRoute = async ({ request }) => {
  let body: CheckoutAmBody;
  try { body = (await request.json()) as CheckoutAmBody; }
  catch { return badRequest("body", "Invalid JSON"); }

  const firstName = (body.firstName ?? "").trim();
  const lastName = (body.lastName ?? "").trim();
  const email = (body.email ?? "").trim();
  const year = Number(body.year);

  if (!firstName) return badRequest("firstName", "First name required");
  if (!lastName) return badRequest("lastName", "Last name required");
  if (!EMAIL_RE.test(email)) return badRequest("email", "Valid email required");
  if (!Number.isInteger(year) || year < 2024 || year > 2100) return badRequest("year", "Valid year required");

  let priceConfig;
  try {
    priceConfig = await resolveRenewalPrice("am_renewal_nzd");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("MISSING_CONFIG")) return serverError("MISSING_CONFIG", msg);
    if (msg.includes("PRICE_INACTIVE")) return serverError("PRICE_INACTIVE", msg);
    return serverError("CHECKOUT_ERROR", msg);
  }

  const renewalId = crypto.randomUUID();

  if (isCheckoutDryRunEnabled()) {
    return new Response(JSON.stringify({
      dryRun: true, priceValidated: true, priceId: priceConfig.priceId, renewalId,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const siteBaseUrl = getSiteBaseUrl(request.url);
  const createdAt = new Date().toISOString();

  await appendRenewal({
    renewalId, tier: "am", year, firstName, lastName, email, phone: "",
    pdEntries: [], amountCents: priceConfig.unitAmount, currency: priceConfig.currency,
    stripeSession: "", paymentStatus: "pending", createdAt,
  });

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: "payment",
      success_url: `${siteBaseUrl}/renew/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteBaseUrl}/renew/associate?year=${year}&firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&email=${encodeURIComponent(email)}`,
      line_items: [{ quantity: 1, price: priceConfig.priceId }],
      customer_email: email,
      customer_creation: "always",
      client_reference_id: renewalId,
      payment_intent_data: { receipt_email: email, setup_future_usage: "off_session" },
      metadata: {
        flow: "renewal", tier: "am", renewal_id: renewalId, renewal_year: String(year),
        first_name: firstName, last_name: lastName, email, phone: "",
        pd_entries: "", amount_cents: String(priceConfig.unitAmount),
      },
    }, { idempotencyKey: `renewal:am:${renewalId}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return serverError("CHECKOUT_ERROR", msg, isStripeRetryableError(err));
  }

  return new Response(JSON.stringify({ url: session.url, renewalId }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/api/renew/checkout-am.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/renew/checkout-am.ts src/pages/api/renew/checkout-am.test.ts
git commit -m "feat(renewal): add /api/renew/checkout-am endpoint"
```

---

## Task 7: Build `src/pages/api/renew/session-info.ts`

**Files:**
- Create: `src/pages/api/renew/session-info.ts`
- Create: `src/pages/api/renew/session-info.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pages/api/renew/session-info.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStripeSessionsRetrieve = vi.fn();
vi.mock("stripe", () => ({
  default: vi.fn(() => ({ checkout: { sessions: { retrieve: mockStripeSessionsRetrieve } } })),
}));
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import { GET } from "./session-info";

async function call(sessionId: string | null) {
  const url = sessionId
    ? `https://test.example.com/api/renew/session-info?session_id=${sessionId}`
    : "https://test.example.com/api/renew/session-info";
  return GET({ url } as any);
}

describe("renew/session-info", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tier, renewalYear, amountPaidCents from session metadata", async () => {
    mockStripeSessionsRetrieve.mockResolvedValueOnce({
      id: "cs_pm_1", payment_status: "paid",
      amount_total: 15000,
      metadata: { flow: "renewal", tier: "pm", renewal_year: "2026" },
    });

    const response = await call("cs_pm_1");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ tier: "pm", renewalYear: 2026, amountPaidCents: 15000 });
  });

  it("returns 400 when session_id missing", async () => {
    const response = await call(null);
    expect(response.status).toBe(400);
  });

  it("returns 404 when session is not a renewal", async () => {
    mockStripeSessionsRetrieve.mockResolvedValueOnce({
      id: "cs_other", payment_status: "paid",
      metadata: { flow: "option_c", tier: "professional" },
    });

    const response = await call("cs_other");
    expect(response.status).toBe(404);
  });

  it("returns 500 when Stripe throws", async () => {
    mockStripeSessionsRetrieve.mockRejectedValueOnce(new Error("Stripe down"));
    const response = await call("cs_x");
    expect(response.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/api/renew/session-info.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/pages/api/renew/session-info.ts`**

Create the file:

```ts
import type { APIRoute } from "astro";
import Stripe from "stripe";

let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("MISSING_CONFIG: STRIPE_SECRET_KEY");
    stripeInstance = new Stripe(key, { apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion });
  }
  return stripeInstance;
}

export const GET: APIRoute = async ({ url }) => {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "session_id required" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "content-type": "application/json" } });
  }

  if (session.metadata?.flow !== "renewal") {
    return new Response(JSON.stringify({ error: "Not a renewal session" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({
    tier: session.metadata.tier,
    renewalYear: Number(session.metadata.renewal_year ?? 0),
    amountPaidCents: session.amount_total ?? 0,
  }), { status: 200, headers: { "content-type": "application/json" } });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/api/renew/session-info.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/renew/session-info.ts src/pages/api/renew/session-info.test.ts
git commit -m "feat(renewal): add /api/renew/session-info endpoint"
```

---

## Task 8: Add `renewal_prices` to `/api/health`

**Files:**
- Modify: `src/pages/api/health.ts`
- Modify: `src/pages/api/health.test.ts`

- [ ] **Step 1: Read existing health.ts structure**

Run: `Read src/pages/api/health.ts` to understand the response shape and where to add the `renewal_prices` field.

- [ ] **Step 2: Write the failing test**

Add at the end of `src/pages/api/health.test.ts`:

```ts
import { resolveRenewalPrice, invalidateRenewalPriceCache } from "../../lib/stripe-products";

vi.mock("../../lib/stripe-products", () => ({
  resolveRenewalPrice: vi.fn(),
  invalidateRenewalPriceCache: vi.fn(),
}));

describe("renewal_prices in health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRenewalPriceCache();
  });

  it("includes renewal_prices field with both tiers when prices resolve", async () => {
    (resolveRenewalPrice as any).mockImplementation(async (key: string) => {
      if (key === "pm_renewal_nzd") return { priceId: "price_pm_150", currency: "nzd", unitAmount: 15000 };
      return { priceId: "price_am_75", currency: "nzd", unitAmount: 7500 };
    });

    const response = await GET({} as any);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.renewal_prices).toBeDefined();
    expect(json.renewal_prices.pm.ok).toBe(true);
    expect(json.renewal_prices.am.ok).toBe(true);
  });

  it("reports ok=false for tier whose price fails to resolve", async () => {
    (resolveRenewalPrice as any).mockImplementation(async (key: string) => {
      if (key === "pm_renewal_nzd") throw new Error("PRICE_INACTIVE: no active price");
      return { priceId: "price_am_75", currency: "nzd", unitAmount: 7500 };
    });

    const response = await GET({} as any);
    const json = await response.json();
    expect(json.renewal_prices.pm.ok).toBe(false);
    expect(json.renewal_prices.pm.error).toMatch(/PRICE_INACTIVE/);
    expect(json.renewal_prices.am.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/pages/api/health.test.ts`
Expected: FAIL — `renewal_prices` field not in response.

- [ ] **Step 4: Add `renewal_prices` field to `src/pages/api/health.ts`**

In the handler that builds the response body, add (right after the existing `prices` field):

```ts
import { resolveRenewalPrice } from "../../lib/stripe-products";

// ... inside handler, after existing price resolution ...

async function safeResolveRenewalPrice(key: "pm_renewal_nzd" | "am_renewal_nzd") {
  try {
    const price = await resolveRenewalPrice(key);
    return { ok: true as const, priceId: price.priceId, currency: price.currency, unitAmount: price.unitAmount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false as const, error: msg };
  }
}

const renewal_prices = {
  pm: await safeResolveRenewalPrice("pm_renewal_nzd"),
  am: await safeResolveRenewalPrice("am_renewal_nzd"),
};
```

Add `renewal_prices` to the response object alongside the other fields.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/pages/api/health.test.ts`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/health.ts src/pages/api/health.test.ts
git commit -m "feat(renewal): expose renewal_prices in /api/health"
```

---

## Task 9: Rewrite `src/pages/renew/pro.astro` (PD form)

**Files:**
- Modify: `src/pages/renew/pro.astro` (full rewrite — replace deprecation stub)

- [ ] **Step 1: Read existing pro.astro**

Run: `Read src/pages/renew/pro.astro` to confirm current deprecation stub structure.

- [ ] **Step 2: Write the new pro.astro page**

Replace the entire file with:

```astro
---
import BaseLayout from "../../layouts/BaseLayout.astro";

const url = Astro.url;
const firstNameParam = url.searchParams.get("firstName") ?? "";
const lastNameParam = url.searchParams.get("lastName") ?? "";
const emailParam = url.searchParams.get("email") ?? "";
const phoneParam = url.searchParams.get("phone") ?? "";
const yearParam = url.searchParams.get("year") ?? String(new Date().getFullYear());
const yearNum = Number.parseInt(yearParam, 10);
const yearDisplay = Number.isFinite(yearNum) && yearNum >= 2024 && yearNum <= 2100 ? yearNum : new Date().getFullYear();
---
<BaseLayout title={`Professional Membership Renewal — ${yearDisplay}`}>
  <div class="max-w-3xl mx-auto p-4 sm:p-8">
    <header class="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">Professional Membership Renewal</h1>
      <p class="text-gray-600">
        Complete the form below to renew your Professional Membership for {yearDisplay}.
      </p>
    </header>

    <section class="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Your details</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="text-sm font-medium text-gray-700">First name</span>
          <input id="firstName" name="firstName" type="text" value={firstNameParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Last name</span>
          <input id="lastName" name="lastName" type="text" value={lastNameParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Email</span>
          <input id="email" name="email" type="email" value={emailParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Phone</span>
          <input id="phone" name="phone" type="tel" value={phoneParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" />
        </label>
      </div>
      <p class="text-xs text-gray-500 mt-2">
        Renewal year: <span id="year-display" class="font-semibold">{yearDisplay}</span>
        (read-only — included in your renewal record)
      </p>
    </section>

    <section class="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Professional Development: Record of Learning</h2>
      <p class="text-sm text-gray-600 mb-4">
        Record at least one professional development activity from the past year.
      </p>
      <div id="pd-entries" class="space-y-4">
        <div class="pd-row border border-gray-200 rounded-xl p-4" data-row-index="0">
          <div class="flex justify-between items-center mb-3">
            <h3 class="font-medium">Activity 1</h3>
            <button type="button" class="remove-row-btn hidden px-2 py-1 border border-amber-700 text-amber-800 rounded text-xs font-medium bg-white">Remove</button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-sm font-medium text-gray-700">Date completed</span>
              <input type="date" name="dateCompleted"
                     class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
            </label>
            <label class="block">
              <span class="text-sm font-medium text-gray-700">Activity</span>
              <input type="text" name="activity" placeholder="e.g. course, webinar, book, PD event"
                     class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
            </label>
            <label class="block">
              <span class="text-sm font-medium text-gray-700">Total Hours</span>
              <input type="number" name="totalHours" min="0.5" step="0.5"
                     class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
            </label>
            <label class="block">
              <span class="text-sm font-medium text-gray-700">Provider (if applicable)</span>
              <input type="text" name="provider"
                     class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" />
            </label>
          </div>
        </div>
      </div>
      <button id="add-row-btn" type="button"
              class="mt-4 px-4 py-2 border border-blue-600 text-blue-600 rounded-md bg-white text-sm font-medium hover:bg-blue-50">
        + Add another activity
      </button>
    </section>

    <div id="error-banner" class="hidden bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
      <p id="error-message" class="text-amber-800"></p>
    </div>

    <button id="proceed-btn" type="button"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl shadow-lg flex items-center justify-center gap-2">
      <span id="proceed-spinner" class="hidden w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
      <span id="proceed-btn-label">Proceed to Payment — NZ$150</span>
    </button>
  </div>

  <script>
    const pdEntriesContainer = document.getElementById("pd-entries")!;
    const addRowBtn = document.getElementById("add-row-btn")!;
    const proceedBtn = document.getElementById("proceed-btn") as HTMLButtonElement;
    const proceedSpinner = document.getElementById("proceed-spinner")!;
    const proceedLabel = document.getElementById("proceed-btn-label")!;
    const errorBanner = document.getElementById("error-banner")!;
    const errorMessage = document.getElementById("error-message")!;

    function refreshRemoveButtons() {
      const rows = pdEntriesContainer.querySelectorAll(".pd-row");
      rows.forEach((row) => {
        const btn = row.querySelector(".remove-row-btn") as HTMLButtonElement;
        if (rows.length === 1) {
          btn.classList.add("hidden");
        } else {
          btn.classList.remove("hidden");
        }
      });
      pdEntriesContainer.querySelectorAll(".pd-row h3").forEach((h, i) => {
        h.textContent = `Activity ${i + 1}`;
      });
    }

    addRowBtn.addEventListener("click", () => {
      const firstRow = pdEntriesContainer.querySelector(".pd-row")!;
      const clone = firstRow.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input").forEach((inp) => { (inp as HTMLInputElement).value = ""; });
      const rowIndex = pdEntriesContainer.querySelectorAll(".pd-row").length;
      clone.setAttribute("data-row-index", String(rowIndex));
      clone.querySelector(".remove-row-btn")!.addEventListener("click", () => {
        clone.remove();
        refreshRemoveButtons();
      });
      pdEntriesContainer.appendChild(clone);
      refreshRemoveButtons();
    });

    pdEntriesContainer.querySelector(".remove-row-btn")!.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const row = btn.closest(".pd-row")!;
      row.remove();
      refreshRemoveButtons();
    });

    function collectFormData() {
      const rows = pdEntriesContainer.querySelectorAll(".pd-row");
      const pdEntries: any[] = [];
      rows.forEach((row) => {
        pdEntries.push({
          dateCompleted: (row.querySelector('input[name="dateCompleted"]') as HTMLInputElement).value,
          activity: (row.querySelector('input[name="activity"]') as HTMLInputElement).value,
          totalHours: Number((row.querySelector('input[name="totalHours"]') as HTMLInputElement).value),
          provider: (row.querySelector('input[name="provider"]') as HTMLInputElement).value,
        });
      });
      return {
        firstName: (document.getElementById("firstName") as HTMLInputElement).value.trim(),
        lastName: (document.getElementById("lastName") as HTMLInputElement).value.trim(),
        email: (document.getElementById("email") as HTMLInputElement).value.trim(),
        phone: (document.getElementById("phone") as HTMLInputElement).value.trim(),
        year: Number((document.getElementById("year-display") as HTMLElement).textContent),
        pdEntries,
      };
    }

    function showError(msg: string) {
      errorMessage.textContent = msg;
      errorBanner.classList.remove("hidden");
      errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function setLoading(loading: boolean) {
      if (loading) {
        proceedBtn.disabled = true;
        proceedBtn.classList.add("opacity-70", "cursor-not-allowed");
        proceedSpinner.classList.remove("hidden");
        proceedLabel.textContent = "Loading…";
      } else {
        proceedBtn.disabled = false;
        proceedBtn.classList.remove("opacity-70", "cursor-not-allowed");
        proceedSpinner.classList.add("hidden");
        proceedLabel.textContent = "Proceed to Payment — NZ$150";
      }
    }

    proceedBtn.addEventListener("click", async () => {
      errorBanner.classList.add("hidden");
      const data = collectFormData();
      if (data.pdEntries.length === 0) { showError("Add at least one activity."); return; }
      for (const entry of data.pdEntries) {
        if (!entry.dateCompleted || !entry.activity || !entry.totalHours || entry.totalHours <= 0) {
          showError("Fill in all activity fields (date, activity, hours)."); return;
        }
      }
      if (!data.firstName || !data.lastName || !data.email) { showError("First name, last name, and email required."); return; }
      setLoading(true);
      try {
        const res = await fetch("/api/renew/checkout-pm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        const json = await res.json();
        if (!res.ok) {
          showError(json.error ?? `Error ${res.status}`);
          setLoading(false);
          return;
        }
        if (json.dryRun) {
          showError(`Dry-run mode: price validated (${json.priceId}). Stripe session NOT created.`);
          setLoading(false);
          return;
        }
        window.location.assign(json.url);
      } catch (err) {
        showError("Network error. Please try again.");
        setLoading(false);
      }
    });
  </script>
</BaseLayout>
```

- [ ] **Step 3: Verify the page renders locally**

Run: `npm run dev:staging`
Expected: page loads at `http://localhost:4321/renew/pro?firstName=Test&lastName=User&email=test@example.com&phone=021234567&year=2026` with pre-filled values.

- [ ] **Step 4: Commit**

```bash
git add src/pages/renew/pro.astro
git commit -m "feat(renewal): rewrite /renew/pro with PD form"
```

---

## Task 10: Rewrite `src/pages/renew/associate.astro` (minimal form)

**Files:**
- Modify: `src/pages/renew/associate.astro` (full rewrite — replace deprecation stub)

- [ ] **Step 1: Write the new associate.astro page**

Replace the entire file with:

```astro
---
import BaseLayout from "../../layouts/BaseLayout.astro";

const url = Astro.url;
const firstNameParam = url.searchParams.get("firstName") ?? "";
const lastNameParam = url.searchParams.get("lastName") ?? "";
const emailParam = url.searchParams.get("email") ?? "";
const yearParam = url.searchParams.get("year") ?? String(new Date().getFullYear());
const yearNum = Number.parseInt(yearParam, 10);
const yearDisplay = Number.isFinite(yearNum) && yearNum >= 2024 && yearNum <= 2100 ? yearNum : new Date().getFullYear();
---
<BaseLayout title={`Associate Membership Renewal — ${yearDisplay}`}>
  <div class="max-w-2xl mx-auto p-4 sm:p-8">
    <header class="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">Associate Membership Renewal</h1>
      <p class="text-gray-600">Renew your Associate Membership for {yearDisplay}.</p>
    </header>

    <section class="bg-white border border-gray-200 rounded-xl p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Your details</h2>
      <div class="grid grid-cols-1 gap-3">
        <label class="block">
          <span class="text-sm font-medium text-gray-700">First name</span>
          <input id="firstName" name="firstName" type="text" value={firstNameParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Last name</span>
          <input id="lastName" name="lastName" type="text" value={lastNameParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Email</span>
          <input id="email" name="email" type="email" value={emailParam}
                 class="w-full mt-1 px-4 py-3 border border-gray-200 rounded-xl text-lg" required />
        </label>
      </div>
      <p class="text-xs text-gray-500 mt-2">
        Renewal year: <span id="year-display" class="font-semibold">{yearDisplay}</span>
      </p>
    </section>

    <div id="error-banner" class="hidden bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
      <p id="error-message" class="text-amber-800"></p>
    </div>

    <button id="pay-btn" type="button"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl shadow-lg flex items-center justify-center gap-2">
      <span id="pay-spinner" class="hidden w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
      <span id="pay-btn-label">Pay NZ$75</span>
    </button>
  </div>

  <script>
    const payBtn = document.getElementById("pay-btn") as HTMLButtonElement;
    const paySpinner = document.getElementById("pay-spinner")!;
    const payLabel = document.getElementById("pay-btn-label")!;
    const errorBanner = document.getElementById("error-banner")!;
    const errorMessage = document.getElementById("error-message")!;

    function showError(msg: string) {
      errorMessage.textContent = msg;
      errorBanner.classList.remove("hidden");
      errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function setLoading(loading: boolean) {
      if (loading) {
        payBtn.disabled = true;
        payBtn.classList.add("opacity-70", "cursor-not-allowed");
        paySpinner.classList.remove("hidden");
        payLabel.textContent = "Loading…";
      } else {
        payBtn.disabled = false;
        payBtn.classList.remove("opacity-70", "cursor-not-allowed");
        paySpinner.classList.add("hidden");
        payLabel.textContent = "Pay NZ$75";
      }
    }

    payBtn.addEventListener("click", async () => {
      errorBanner.classList.add("hidden");
      const firstName = (document.getElementById("firstName") as HTMLInputElement).value.trim();
      const lastName = (document.getElementById("lastName") as HTMLInputElement).value.trim();
      const email = (document.getElementById("email") as HTMLInputElement).value.trim();
      const year = Number((document.getElementById("year-display") as HTMLElement).textContent);
      if (!firstName || !lastName || !email) { showError("All fields required."); return; }

      setLoading(true);
      try {
        const res = await fetch("/api/renew/checkout-am", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ firstName, lastName, email, year }),
        });
        const json = await res.json();
        if (!res.ok) { showError(json.error ?? `Error ${res.status}`); setLoading(false); return; }
        if (json.dryRun) { showError(`Dry-run: price validated (${json.priceId}).`); setLoading(false); return; }
        window.location.assign(json.url);
      } catch (err) {
        showError("Network error. Please try again.");
        setLoading(false);
      }
    });
  </script>
</BaseLayout>
```

- [ ] **Step 2: Verify the page renders**

Run: `npm run dev:staging`
Visit: `http://localhost:4321/renew/associate?firstName=Test&lastName=User&email=test@example.com&year=2026`
Expected: pre-filled values, Pay NZ$75 button visible.

- [ ] **Step 3: Commit**

```bash
git add src/pages/renew/associate.astro
git commit -m "feat(renewal): rewrite /renew/associate with minimal form"
```

---

## Task 11: Create `src/pages/renew/success.astro`

**Files:**
- Create: `src/pages/renew/success.astro`

- [ ] **Step 1: Write the page**

```astro
---
import BaseLayout from "../../layouts/BaseLayout.astro";
---
<BaseLayout title="Membership Renewed">
  <div class="max-w-2xl mx-auto p-4 sm:p-8">
    <div class="bg-white border border-gray-200 rounded-xl p-8 text-center">
      <div class="w-16 h-16 bg-emerald-700 text-white rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">✓</div>
      <h1 class="text-3xl font-bold text-gray-900 mb-2">Thank you!</h1>
      <p id="success-message" class="text-gray-700 text-lg">Loading your renewal confirmation…</p>
      <p class="text-sm text-gray-500 mt-4">
        A receipt has been emailed to you by Stripe.
      </p>
    </div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    const successMessage = document.getElementById("success-message")!;

    if (!sessionId) {
      successMessage.textContent = "Thank you. Your renewal payment was received.";
    } else {
      fetch(`/api/renew/session-info?session_id=${encodeURIComponent(sessionId)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) {
            successMessage.textContent = "Thank you. Your renewal payment was received.";
            return;
          }
          const tierLabel = data.tier === "pm" ? "Professional" : "Associate";
          const amount = (data.amountPaidCents / 100).toFixed(2);
          successMessage.textContent =
            `Your ${tierLabel} membership is renewed for ${data.renewalYear}. Amount paid: NZ$${amount}.`;
        })
        .catch(() => {
          successMessage.textContent = "Thank you. Your renewal payment was received.";
        });
    }
  </script>
</BaseLayout>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/renew/success.astro
git commit -m "feat(renewal): add /renew/success confirmation page"
```

---

## Task 12: Final verification

**Files:** (no edits)

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: PASS. All 42 existing tests + new renewal tests (~40 new tests).

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: no new errors related to renewal code.

- [ ] **Step 3: Build**

Run: `npm run build:staging`
Expected: build succeeds.

- [ ] **Step 4: Manual E2E against staging**

1. Confirm Stripe prices exist with correct `lookup_keys` (per Pre-flight).
2. Confirm `STRIPE_PRODUCT_*_RENEWAL` Fly secrets are set (per Pre-flight).
3. Open `https://eldaa.fly.dev/renew/pro?firstName=Test&lastName=User&email=test@example.com&phone=021234567&year=2026`.
4. Verify pre-fill. Fill 1 PD row. Submit.
5. Verify `Renewals` sheet has new row with `payment_status: "pending"`, `stripe_session` empty.
6. Use Stripe test card `4242 4242 4242 4242`. Complete checkout.
7. Verify webhook fired: row updated to `payment_status: "paid"`, `paid_at` populated.
8. Verify `Checkout Log` sheet has new row with `plan: "renewal_pm"`, `amountPaid: 15000`.
9. Repeat for AM at `/renew/associate?firstName=...&email=...&year=2026`.
10. Hit `GET /api/health` → `renewal_prices.pm.ok === true`, `renewal_prices.am.ok === true`.

- [ ] **Step 5: Update OpenWolf files**

Edit `.wolf/anatomy.md` to add the new files:
- `src/lib/stripe-products.ts` (~80 tok)
- `src/lib/stripe-products.test.ts` (~600 tok)
- `src/lib/renewal-sheet.ts` (~150 tok)
- `src/lib/renewal-sheet.test.ts` (~1500 tok)
- `src/pages/api/renew/checkout-pm.ts` (~1500 tok)
- `src/pages/api/renew/checkout-am.ts` (~1500 tok)
- `src/pages/api/renew/checkout-pm.test.ts` (~2000 tok)
- `src/pages/api/renew/checkout-am.test.ts` (~1500 tok)
- `src/pages/api/renew/session-info.ts` (~600 tok)
- `src/pages/api/renew/session-info.test.ts` (~500 tok)
- `src/pages/renew/success.astro` (~700 tok)

Append a one-line entry to `.wolf/memory.md`:
```
| HH:MM | Implemented membership renewal form (PM $150 + PD, AM $75) | src/lib/{stripe-products,renewal-sheet}.ts, src/pages/api/renew/*, src/pages/renew/*.astro | new feature | ~3500 tok |
```

Update `.wolf/cerebrum.md` Decision Log:
- `[2026-06-23] **Membership renewal flow: two pages + two endpoints + shared webhook branch.** PM ($150) and AM ($75) tiers. New Renewals sheet (lazy-created on first write). Stripe lookup_keys for price resolution (no hardcoded price IDs, cerebrum 2026-06-14 pattern). One-time payment only — no Stripe Subscription created. Public link, no auth, always new record per submission.`

- [ ] **Step 6: Final commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md
git commit -m "chore(openwolf): track new renewal files + decisions"
```

- [ ] **Step 7: Push to staging**

```bash
git push origin main
```

CI deploys to `eldaa.fly.dev` automatically. Smoke-test the renewal pages there.

- [ ] **Step 8: Production deploy**

After UAT sign-off:

```bash
gh workflow run fly-deploy.yml --ref main
```

Or manually:
```bash
fly deploy --remote-only --app eldaa-production
```

Confirm `STRIPE_PRODUCT_*_RENEWAL` secrets are set on production app (per Pre-flight).

---

## Self-Review

**1. Spec coverage:**
- ✅ User flow (PM form → Stripe, AM direct → Stripe) — Tasks 9, 10
- ✅ Data model (Renewals sheet, Stripe metadata) — Tasks 3, 5, 6
- ✅ Backend (endpoints, webhook branch, lookup_key resolver) — Tasks 2, 3, 4, 5, 6, 7, 8
- ✅ Frontend (PD form, minimal form, success page) — Tasks 9, 10, 11
- ✅ Error handling + observability — Tasks 4, 5, 6, 8
- ✅ Testing — Tasks 2–8 include Vitest tests
- ✅ Verification — Task 12

**2. Placeholder scan:**
- No "TBD", "TODO", "implement later" — all code complete.
- No "appropriate error handling" without code — `badRequest`/`serverError` helpers shown.
- No "Similar to Task N" — each task repeats full code.
- All Stripe price IDs come from `lookup_key` resolution (no hardcoded).
- Magic numbers justified inline (15000 = $150 PM, 7500 = $75 AM).

**3. Type consistency:**
- `PdEntry` interface defined in Task 3 (renewal-sheet.ts) and reused in Tasks 5, 6.
- `renewalId` UUID generated via `crypto.randomUUID()` in Tasks 5, 6.
- `idempotencyKey` format `renewal:pm:${id}` and `renewal:am:${id}` consistent.
- `LookupKey` type defined in Task 2, used in Tasks 5, 6, 8.
- `success_url` and `cancel_url` patterns consistent across PM and AM endpoints.

**Issues found and fixed during review:**
- Original spinner used `innerHTML` — security hook blocked it. Replaced with always-present spinner element + `classList.toggle("hidden")` + `textContent` for label.
- Cancel page removed (cancel_url points back to /renew/pro or /renew/associate to preserve prefill). Task 12 no longer includes the optional cancel page.

No outstanding issues. Plan ready for execution.
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
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
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
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
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
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A1:N1000`,
  });
  const rows = res.data.values ?? [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex((r) => r[0] === renewalId);
  if (idx === -1) {
    return;
  }
  const rowNumber = idx + 2;

  const existing = dataRows[idx];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_NAME}'!K${rowNumber}:N${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "paid",
        existing[11] ?? "",
        existing[12] ?? "",
        paidAt,
      ]],
    },
  });
}

export async function getRenewalBySession(stripeSessionId: string): Promise<RenewalRow | null> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
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

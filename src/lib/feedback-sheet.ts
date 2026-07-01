import { google } from "googleapis";
import { getServiceAccountJwtAuth } from "./google-auth";
import { logger } from "./logger";

export interface FeedbackInput {
  timestamp: string;
  type: "inline" | "post_submission";
  page: string;
  reaction?: string;
  comment?: string;
  answers?: Record<string, string>;
}

export interface FeedbackRow {
  timestamp: string;
  type: string;
  page: string;
  reaction: string;
  comment: string;
  answers: Record<string, string>;
}

const FEEDBACK_HEADERS = [
  "timestamp", "type", "page", "reaction", "comment", "answers",
] as const;

const SHEET_NAME = "Feedback";

let sheetsClientPromise: Promise<ReturnType<typeof google.sheets>> | null = null;

async function getSheetsClient() {
  // Cache the auth-warmed client across all calls in this process, matching
  // renewal-sheet.ts's pattern.
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = getServiceAccountJwtAuth(["https://www.googleapis.com/auth/spreadsheets"]);
      await withTransientRetry("oauth_token_refresh", async () => {
        await auth.authorize();
      });
      return google.sheets({ version: "v4", auth });
    })();
  }
  return sheetsClientPromise;
}

// Google OAuth token endpoint drops connections intermittently with
// "Premature close" / "ECONNRESET" / "EAI_AGAIN". These are transient and
// retrying the underlying Sheets call recovers cleanly.
function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code;
  if (msg.includes("Premature close")) return true;
  if (msg.includes("ECONNRESET")) return true;
  if (msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("EAI_AGAIN")) return true;
  if (msg.includes("socket hang up")) return true;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") return true;
  return false;
}

async function withTransientRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAYS_MS = [500, 1000, 2000, 4000]; // index = attempt-2
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === MAX_ATTEMPTS) throw err;
      const base = BASE_DELAYS_MS[attempt - 2] ?? 4000;
      const jitter = Math.floor(base * 0.2 * (Math.random() * 2 - 1));
      const delayMs = base + jitter;
      logger.warn("feedback_sheet_transient_retry", {
        label, attempt, maxAttempts: MAX_ATTEMPTS, delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable: last iteration either returns or throws.
  throw lastErr;
}

export function _resetSheetsClientCacheForTesting(): void {
  sheetsClientPromise = null;
}

async function ensureFeedbackSheet(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = await getSheetsClient();

  const meta = await withTransientRetry("ensure_feedback_sheet.get", () =>
    sheets.spreadsheets.get({ spreadsheetId }),
  );
  const existing = (meta.data.sheets ?? []).find((s) => s.properties?.title === SHEET_NAME);

  if (!existing) {
    await withTransientRetry("ensure_feedback_sheet.batchUpdate", () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
        },
      }),
    );
    await withTransientRetry("ensure_feedback_sheet.headers", () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${SHEET_NAME}'!A1:F1`,
        valueInputOption: "RAW",
        requestBody: { values: [FEEDBACK_HEADERS as unknown as string[]] },
      }),
    );
    return;
  }

  // Self-heal: sheet exists but header row may be missing (e.g. an earlier
  // creation run whose header write failed). Mirrors renewal-sheet.ts.
  const firstRowRes = await withTransientRetry("ensure_feedback_sheet.header_check", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A1:A1`,
    }),
  );
  const a1 = firstRowRes.data.values?.[0]?.[0];
  if (a1 === FEEDBACK_HEADERS[0]) return;

  const sheetId = existing.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return;

  await withTransientRetry("ensure_feedback_sheet.insert_header_row", () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
            inheritFromBefore: false,
          },
        }],
      },
    }),
  );
  await withTransientRetry("ensure_feedback_sheet.backfill_headers", () =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [FEEDBACK_HEADERS as unknown as string[]] },
    }),
  );
}

export async function appendFeedback(input: FeedbackInput): Promise<void> {
  await ensureFeedbackSheet();

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = await getSheetsClient();

  const row = [
    input.timestamp,
    input.type,
    input.page,
    input.reaction ?? "",
    input.comment ?? "",
    JSON.stringify(input.answers ?? {}),
  ];

  await withTransientRetry("append_feedback", () =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    }),
  );
}

export async function readFeedback(): Promise<FeedbackRow[]> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("MISSING_CONFIG: GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = await getSheetsClient();

  const res = await withTransientRetry("read_feedback", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SHEET_NAME}'!A1:F10000`,
    }),
  );
  const rows = res.data.values ?? [];
  const dataRows = rows.slice(1);

  return dataRows.map((r) => {
    let answers: Record<string, string> = {};
    try { answers = JSON.parse(r[5] ?? "{}"); } catch { answers = {}; }
    return {
      timestamp: r[0] ?? "",
      type: r[1] ?? "",
      page: r[2] ?? "",
      reaction: r[3] ?? "",
      comment: r[4] ?? "",
      answers,
    };
  });
}

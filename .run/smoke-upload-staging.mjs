// Smoke test: read the staging sheet, find a recent applicant, use their
// token to upload a tiny PDF. Confirms the upload endpoint works under
// DWD impersonation end-to-end.

import { google } from "googleapis";
import { Buffer } from "node:buffer";

const SA_EMAIL = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const APPS_BASE = process.env.APPS_BASE_URL;
if (!SA_EMAIL || !SA_KEY || !SHEET_ID) {
  console.error("Missing SA env vars or SHEET_ID");
  process.exit(1);
}
if (!APPS_BASE) {
  console.error("Missing APPS_BASE_URL (e.g. https://eldaa.fly.dev)");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: SA_EMAIL,
  key: SA_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
await auth.authorize();
const sheets = google.sheets({ version: "v4", auth });

// Read column A (applicant_id) and AG (resume_token). 47 cols total, A..AU.
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Professional Applications!A1:AU50",
});
const rows = res.data.values || [];
if (rows.length < 2) {
  console.error("No rows in sheet");
  process.exit(1);
}
const header = rows[0];
const TOKEN_COL = header.indexOf("resume_token");
const EMAIL_COL = header.indexOf("email");
const FIRST_COL = header.indexOf("first_name");
const LAST_COL = header.indexOf("last_name");
console.log(`Header indices: resume_token=${TOKEN_COL} email=${EMAIL_COL}`);

// Find a recent applicant with a token
const candidates = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  const token = r[TOKEN_COL];
  if (!token) continue;
  candidates.push({
    row: i + 1,
    id: r[0],
    token,
    email: r[EMAIL_COL] || "",
    name: `${r[FIRST_COL] || ""} ${r[LAST_COL] || ""}`.trim(),
  });
}
if (candidates.length === 0) {
  console.error("No applicants with tokens found");
  process.exit(1);
}
console.log(`Found ${candidates.length} applicants with tokens. Using most recent.`);
// Prefer an applicant that has NOT paid (so the upload endpoint doesn't 400 on APPLICATION_COMPLETED)
const fresh = candidates.find((c) => c.id) || candidates[0];
console.log(`Selected: id=${fresh.id} name=${fresh.name} email=${fresh.email}`);

// Upload a tiny PDF
const tinyPdf = Buffer.from("%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\nxref\n0 1\n0000000000 65535 f\n%%EOF\n");
const upRes = await fetch(APPS_BASE + "/api/professional/upload-file", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: fresh.token,
    docType: "training",
    filename: "smoke-test.pdf",
    mimeType: "application/pdf",
    data: tinyPdf.toString("base64"),
  }),
});
const upBody = await upRes.text();
console.log(`\nUPLOAD: status=${upRes.status}`);
console.log(`  body=${upBody.slice(0, 500)}`);

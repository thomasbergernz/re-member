// Diagnose why applicant b68936c3-2acf-45c4-b103-24108d1d23f7 is reported as incomplete.
import { google } from "googleapis";

const SA_EMAIL = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
if (!SA_EMAIL || !SA_KEY || !SHEET_ID) {
  console.error("Missing SA env vars or SHEET_ID");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: SA_EMAIL, key: SA_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
await auth.authorize();
const sheets = google.sheets({ version: "v4", auth });

const TOKEN = "b68936c3-2acf-45c4-b103-24108d1d23f7";

// 1. Find the row in Professional Applications with this token (column AG = resume_token, index 32)
const rows = (await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Professional Applications!A1:AU200",
})).data.values || [];
const header = rows[0];
const COL = {
  id: 0, email: 1, firstName: 2, lastName: 3, phone: 4, dob: 5, ethnicity: 6,
  address: 7, postal: 8, business: 9, website: 10, qualifications: 11, experience: 12,
  furtherReq: 13, coreComp: 14, r1name: 15, r1role: 16, r1email: 17, r1phone: 18,
  r2name: 19, r2role: 20, r2email: 21, r2phone: 22, decl: 23, declE: 24, declS: 25,
  declD: 26, declI: 27, declP: 28, declC: 29, declM: 30, declSigned: 31,
  token: 32, emailHash: 33,
  docTraining: 34, docEthics: 35, docCriminal: 36, docAdvanceCare: 37,
  docAssistedDying: 38, docFundamentals: 39, docInsurance: 40,
  complete: 41, stripe: 42, paid: 43, created: 44, paidAt: 45, spare: 46,
  emailVerified: 47,
};

const found = rows.findIndex((r, i) => i > 0 && r[COL.token] === TOKEN);
if (found < 0) {
  console.error("Token not found in Professional Applications");
  process.exit(1);
}
const row = rows[found];
console.log(`FOUND row ${found + 1} (applicant_id=${row[COL.id]})`);
console.log(`name: ${row[COL.firstName]} ${row[COL.lastName]}, email: ${row[COL.email]}, created: ${row[COL.created]}`);
console.log(`paid: ${row[COL.paid]}, complete: ${row[COL.complete]}, emailVerified: ${row[COL.emailVerified]}`);

console.log("\n=== FORM FIELDS ===");
const fieldChecks = [
  ["firstName", row[COL.firstName]], ["lastName", row[COL.lastName]], ["phone", row[COL.phone]],
  ["dob", row[COL.dob]], ["ethnicity", row[COL.ethnicity]], ["address", row[COL.address]],
  ["postal", row[COL.postal]], ["business", row[COL.business]], ["website", row[COL.website]],
  ["qualifications", row[COL.qualifications]], ["experience", row[COL.experience]],
  ["furtherReq", row[COL.furtherReq]], ["coreComp", row[COL.coreComp]],
  ["r1name", row[COL.r1name]], ["r1role", row[COL.r1role]], ["r1email", row[COL.r1email]], ["r1phone", row[COL.r1phone]],
  ["r2name", row[COL.r2name]], ["r2role", row[COL.r2role]], ["r2email", row[COL.r2email]], ["r2phone", row[COL.r2phone]],
  ["declAccuracy", row[COL.decl]], ["declEthics", row[COL.declE]], ["declScope", row[COL.declS]],
  ["declDoulaServices", row[COL.declD]], ["declInterview", row[COL.declI]],
  ["declProfDev", row[COL.declP]], ["declCriminal", row[COL.declC]], ["declMeetings", row[COL.declM]],
  ["declSignedAt", row[COL.declSigned]],
];
for (const [name, val] of fieldChecks) {
  const status = val && val.length > 0 ? "OK" : "EMPTY";
  const display = val ? (val.length > 60 ? val.slice(0, 60) + "..." : val) : "(blank)";
  console.log(`  [${status.padEnd(5)}] ${name.padEnd(20)} = ${display}`);
}

console.log("\n=== DOC COUNTS (sheet columns AI-AN) ===");
const docChecks = [
  ["training", row[COL.docTraining]], ["ethics", row[COL.docEthics]],
  ["criminal", row[COL.docCriminal]], ["advance_care", row[COL.docAdvanceCare]],
  ["assisted_dying", row[COL.docAssistedDying]], ["fundamentals", row[COL.docFundamentals]],
  ["insurance (optional)", row[COL.docInsurance]],
];
for (const [name, val] of docChecks) {
  console.log(`  [${(val || "0").padStart(3)}] ${name}`);
}

// 2. Cross-check with Drive Files sheet (authoritative count from drive-files.ts)
const driveFiles = (await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Drive Files!A1:F200",
})).data.values || [];
const applicantId = row[COL.id];
const liveCounts = {};
for (let i = 1; i < driveFiles.length; i++) {
  const r = driveFiles[i];
  if (r[1] !== applicantId) continue;
  if (r[5] === "TRUE") continue; // soft-deleted
  const docType = r[2];
  liveCounts[docType] = (liveCounts[docType] || 0) + 1;
}
console.log(`\n=== DRIVE FILES (live, non-deleted rows for ${applicantId}) ===`);
for (const [name, count] of Object.entries(liveCounts)) {
  console.log(`  [${String(count).padStart(3)}] ${name}`);
}
for (const required of ["training","ethics","criminal","advance_care","assisted_dying","fundamentals"]) {
  if (!liveCounts[required]) console.log(`  [   0] ${required}  ← MISSING (required)`);
}

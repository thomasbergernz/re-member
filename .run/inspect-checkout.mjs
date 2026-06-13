// Look up a Stripe session in the checkout log to find the matching applicant.
import { google } from "googleapis";

const SA_EMAIL = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const IMPERSONATE = process.env.GOOGLE_WORKSPACE_IMPERSONATE_USER;

const auth = new google.auth.JWT({
  email: SA_EMAIL, key: SA_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"],
  subject: IMPERSONATE,
});
await auth.authorize();
const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

const SESSION = "cs_test_a1ZhPu9Met93Zm8nVUSrDiyZ2aiV0aPQMjbDitrzrfFwsG3zpQ7s43CAnk";

// 1. List all sheet tabs to find checkout log
const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
const tabs = meta.data.sheets.map((s) => s.properties.title);
console.log("TABS:", tabs);

let checkoutLog = null;
for (const tab of tabs) {
  const data = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:Z200` })).data.values || [];
  for (let i = 1; i < data.length; i++) {
    if (data[i].includes(SESSION)) {
      console.log(`\nFOUND session in tab '${tab}' row ${i + 1}:`);
      console.log(data[i].slice(0, 10));
      checkoutLog = { tab, row: data[i] };
      break;
    }
  }
  if (checkoutLog) break;
}
if (!checkoutLog) {
  console.log("\nSession not in any tab. Checking if there's a separate checkout log sheet.");
}

// 2. Get applicant from token b68936c3-2acf-45c4-b103-24108d1d23f7
const tokenRows = (await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "Professional Applications!A1:AU200",
})).data.values || [];
const applicant = tokenRows.find((r, i) => i > 0 && r[32] === "b68936c3-2acf-45c4-b103-24108d1d23f7");
if (!applicant) {
  console.log("Token not found");
  process.exit(1);
}
const applicantId = applicant[0];
const firstName = applicant[2];
const lastName = applicant[3];
const email = applicant[1];
console.log(`\n=== APPLICANT (id=${applicantId}) ===`);
console.log(`  name: ${firstName} ${lastName}`);
console.log(`  email: ${email}`);
console.log(`  paid: ${applicant[43]}  paid_at: ${applicant[45]}  stripe_session: ${applicant[42]}`);

// 3. Search Drive for the review doc by applicant name + email
const search = await drive.files.list({
  q: `name contains '${firstName} ${lastName}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
  fields: "files(id,name,parents,driveId,createdTime,owners(emailAddress),webViewLink)",
  spaces: "drive",
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  pageSize: 50,
});
console.log(`\n=== DRIVE SEARCH for "${firstName} ${lastName}" docs ===  count=${search.data.files?.length || 0}`);
for (const f of search.data.files || []) {
  console.log(`  - ${f.name}  id=${f.id}  parents=${JSON.stringify(f.parents)}  link=${f.webViewLink}`);
}

// 4. Look for the doc by its exact title pattern
const exactTitle = `Professional Application — ${firstName} ${lastName} (${email})`;
const exactSearch = await drive.files.list({
  q: `name = '${exactTitle.replace(/'/g, "\\'")}' and trashed=false`,
  fields: "files(id,name,parents,trashed,webViewLink)",
  spaces: "drive",
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});
console.log(`\n=== EXACT TITLE SEARCH ===  count=${exactSearch.data.files?.length || 0}`);
for (const f of exactSearch.data.files || []) {
  console.log(`  - id=${f.id}  name=${f.name}  trashed=${f.trashed}  link=${f.webViewLink}`);
}

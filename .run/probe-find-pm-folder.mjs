// One-off: locate the actual parent of PM Applications folder.
import { google } from "googleapis";

const SA_EMAIL = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
const IMPERSONATE = process.env.GOOGLE_WORKSPACE_IMPERSONATE_USER;
const auth = new google.auth.JWT({
  email: SA_EMAIL,
  key: SA_KEY,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject: IMPERSONATE,
});
await auth.authorize();
const drive = google.drive({ version: "v3", auth });

// 1. Get full metadata for PM Applications
const pm = await drive.files.get({
  fileId: "1Nn-F5Cf-0xj02AYZFOZ3ba61QCviuyib",
  fields: "id,name,parents,driveId,trashed,owners(emailAddress)",
  supportsAllDrives: true,
});
console.log(`\n[PM APPS] name=${pm.data.name}  trashed=${pm.data.trashed}  driveId=${pm.data.driveId}`);
console.log(`  parents=${JSON.stringify(pm.data.parents)}`);

// 2. Get metadata for the parent
for (const pid of pm.data.parents || []) {
  try {
    const p = await drive.files.get({
      fileId: pid,
      fields: "id,name,mimeType,driveId,trashed",
      supportsAllDrives: true,
    });
    console.log(`\n[PARENT ${pid}] name=${p.data.name}  mime=${p.data.mimeType}  driveId=${p.data.driveId}  trashed=${p.data.trashed}`);
  } catch (err) {
    console.log(`\n[PARENT ${pid} ERR] code=${err.code} ${err.response?.data?.error?.message || err.message}`);
  }
}

// 3. Try to find PM Applications by name across the entire drive (impersonation scope)
const search = await drive.files.list({
  q: `name='PM Applications' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  fields: "files(id,name,parents,driveId,trashed,owners(emailAddress))",
  spaces: "drive",
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  pageSize: 50,
});
console.log(`\n[SEARCH PM Applications] count=${search.data.files?.length || 0}`);
for (const f of search.data.files || []) {
  console.log(`  - id=${f.id}  name=${f.name}  parents=${JSON.stringify(f.parents)}  driveId=${f.driveId}  trashed=${f.trashed}`);
  console.log(`    owners=${JSON.stringify(f.owners?.map((o) => o.emailAddress))}`);
}

// 4. Same for AM Applications
const am = await drive.files.list({
  q: `name='AM Applications' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  fields: "files(id,name,parents,driveId,trashed)",
  spaces: "drive",
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  pageSize: 50,
});
console.log(`\n[SEARCH AM Applications] count=${am.data.files?.length || 0}`);
for (const f of am.data.files || []) {
  console.log(`  - id=${f.id}  name=${f.name}  parents=${JSON.stringify(f.parents)}  driveId=${f.driveId}  trashed=${f.trashed}`);
}

// 5. Try the explicit list using appsFolderId (the production env's value)
const APPS_FOLDER = process.env.GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID;
const list = await drive.files.list({
  q: `name='PM Applications' and '${APPS_FOLDER}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  fields: "files(id,name)",
  spaces: "drive",
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});
console.log(`\n[LIST with parent=${APPS_FOLDER}] count=${list.data.files?.length || 0}`);

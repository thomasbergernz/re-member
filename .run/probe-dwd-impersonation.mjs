// One-off: verify DWD impersonation under it-admin@eldaa.org.nz
// 1. Lists the apps folder (GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID) under
//    impersonation, which is what the upload endpoint's first Drive call
//    (ensureFolderExists) does.
// 2. Tries to create + delete a test folder inside the same parent to
//    confirm write scope under the impersonation user.

import { google } from "googleapis";

const SA_EMAIL = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n");
const IMPERSONATE = process.env.GOOGLE_WORKSPACE_IMPERSONATE_USER;
const APPS_FOLDER = process.env.GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID;

if (!SA_EMAIL || !SA_KEY || !IMPERSONATE || !APPS_FOLDER) {
  console.error("Missing required env: SA_EMAIL/SA_KEY/IMPERSONATE/APPS_FOLDER");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: SA_EMAIL,
  key: SA_KEY,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject: IMPERSONATE,
});
await auth.authorize();
const drive = google.drive({ version: "v3", auth });

console.log(`\n[IMPERSONATING] ${IMPERSONATE}`);

// 1. Read the apps folder metadata + list children
try {
  const meta = await drive.files.get({
    fileId: APPS_FOLDER,
    fields: "id,name,mimeType,driveId,parents,capabilities,trashed",
    supportsAllDrives: true,
  });
  console.log(`\n[APPS FOLDER META] name=${meta.data.name}  driveId=${meta.data.driveId}  trashed=${meta.data.trashed}`);
  console.log(`  canAddChildren=${meta.data.capabilities?.canAddChildren}  canListChildren=${meta.data.capabilities?.canListChildren}`);
} catch (err) {
  console.log(`\n[APPS FOLDER ERR] code=${err.code} ${err.response?.data?.error?.message || err.message}`);
}

try {
  const list = await drive.files.list({
    q: `'${APPS_FOLDER}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name,trashed,capabilities)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  console.log(`\n[CHILDREN OF APPS FOLDER]`);
  for (const f of list.data.files || []) {
    console.log(`  - ${f.name}  id=${f.id}  canAddChildren=${f.capabilities?.canAddChildren}`);
  }
} catch (err) {
  console.log(`\n[LIST ERR] code=${err.code} ${err.response?.data?.error?.message || err.message}`);
}

// 2. Probe PM Applications leaf folder (the actual upload target)
const PM_FOLDER = "1Nn-F5Cf-0xj02AYZFOZ3ba61QCviuyib";
try {
  const meta = await drive.files.get({
    fileId: PM_FOLDER,
    fields: "id,name,parents,driveId,capabilities,trashed",
    supportsAllDrives: true,
  });
  console.log(`\n[PM FOLDER META] name=${meta.data.name}  driveId=${meta.data.driveId}  trashed=${meta.data.trashed}`);
  console.log(`  canAddChildren=${meta.data.capabilities?.canAddChildren}  canListChildren=${meta.data.capabilities?.canListChildren}`);
} catch (err) {
  console.log(`\n[PM FOLDER ERR] code=${err.code} ${err.response?.data?.error?.message || err.message}`);
}

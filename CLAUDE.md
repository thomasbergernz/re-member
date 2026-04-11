# Professional Membership — Phase 2: Digital Form + Multi-File Upload

**Date:** 2026-04-01
**Status:** Draft

---

## Scope

Two separate but related improvements:

**A) Multi-file upload per category** — applicants can upload multiple files per doc type (e.g., multiple training certificates). Currently each category holds exactly one file.

**B) Digital form fields** — capture applicant details (name, address, phone, email, qualifications, experience, declaration) directly in the form instead of requiring a PDF upload for the "Application Form" category.

---

## A) Multi-File Upload

### Problem
Currently `doc_training` etc. store a single timestamp per category. Applicants with multiple certificates must zip them. No way to delete or replace a file.

### Solution: Drive Files Tracking Sheet

Create a new sheet tab `"Drive Files"` alongside `"Professional Applications"`:

```
Columns: file_id | applicant_id | doc_type | original_filename | uploaded_at | deleted
```

- One row **per file** (not per applicant)
- `deleted` = "TRUE" for soft deletes (allows undelete; actual file stays in Drive but is ignored)
- Applicant's Drive folder: `/applications/{applicant_id}/documents/{doc_type}/{file_id}.{ext}`
  - Single `documents` subfolder per applicant instead of one per doc type
- `doc_application`, `doc_training`, etc. columns in the main sheet become informational (presence = at least one non-deleted file exists for that doc type) — stored as `"N file(s)"` or count

### File Naming Convention
- `{random_uuid}.{ext}` — no original filenames in Drive, only in Drive Files sheet
- Prevents path conflicts and information leakage

### API Changes

**`POST /api/professional/upload-file`** (modified)
- Accepts `docType` + `file`
- Uploads to Drive folder path: `/applications/{applicant_id}/documents/{docType}/{uuid}.{ext}`
- Inserts row into `Drive Files` sheet: `{file_id, applicant_id, docType, original_filename, timestamp, "FALSE"}`
- Returns: `{ success: true, fileId, filename }`
- On error: log + return error (do not update main sheet doc timestamp)

**`DELETE /api/professional/upload-file?fileId=xxx`**
- Soft-delete: set `deleted="TRUE"` on the row in `Drive Files` sheet
- Does NOT delete the actual Drive file (Drive API: `files.update` with `trashed=true`)
- Returns: `{ success: true }`

**`GET /api/professional/upload-files?token=xxx`**
- Returns all non-deleted files for this applicant: `[{ fileId, docType, filename, uploadedAt }]`

**`GET /api/professional/apply?token=xxx`** (modified `GET` response)
- Instead of `docsUploaded: string[]` (timestamps), returns `docsUploaded: { [docType]: FileInfo[] }`
- `FileInfo: { fileId, filename, uploadedAt }`
- `status: "complete"` when every docType has ≥1 non-deleted file

### UI Changes (`apply.astro`)

- Each doc type card shows **list of uploaded files** (filename + timestamp) not just a badge
- Each uploaded file has a **Delete button** (triggers `DELETE /upload-file`)
- Each doc type still has **"Add another" button** to upload more files
- Progress counter changes from "N / 7" to "N of 7 categories complete" (a category is complete if ≥1 file uploaded)
- No file limit per category

### Google Sheet Changes

**`Drive Files` tab** (new):
```
Columns: file_id | applicant_id | doc_type | original_filename | uploaded_at | deleted
```
- Created on first file upload (lazy — `ensureSheetExists` pattern)
- Headers row = row 1

**`Professional Applications` tab** (existing — modify):
- Add `doc_application_count`, `doc_training_count`, ... `doc_fundamentals_count` columns (N=18 → S=25)
  - Or keep as timestamp presence and count via Drive Files lookup at render time
  - **Decision:** Keep as-is (presence only). Count comes from Drive Files at display/check time.

---

## B) Digital Form Fields

### New Form Sections in `apply.astro`

Add between the existing registration form and the upload section:

**Section: "About You"**
```
First Name     [text]
Last Name      [text]
Email          [email]
Phone          [tel]           ← already exists
Address        [text]
City/Town      [text]
Postcode       [text]
Website        [text, optional]
Qualifications [text]          e.g. RN, OT, SW
Current Role   [text]
Organisation   [text]
```

**Section: "Your EOL Doula Experience"**
```
Description    [textarea, 4 rows]
```

**Section: "Confirmations"**
```
☐ I confirm the information provided is accurate
☐ I have read and agree to the ELDAA Code of Ethics
☐ I have read and understand the Scope of Practice
```

**Section: "Upload Supporting Documents"**
(moves existing upload interface here — replaces `doc_application` PDF upload)

### New Columns in `Professional Applications` Sheet

Add after existing columns (after `last_name` at D, `phone` at E):

| Column | Header | Notes |
|--------|--------|-------|
| F | `address` | |
| G | `city` | |
| H | `postcode` | |
| I | `website` | optional |
| J | `qualifications` | |
| K | `current_role` | |
| L | `organisation` | |
| M | `experience` | free text |
| N | `confirm_accuracy` | "TRUE"/"FALSE" |
| O | `confirm_ethics` | "TRUE"/"FALSE" |
| P | `confirm_scope` | "TRUE"/"FALSE" |
| Q | `declaration_signed_at` | ISO timestamp |

**Existing column shift:**
- Old `resume_token` (col C) → now col R
- Old `email_hash` (col D) → now col S
- etc. — all subsequent columns shift +9

### API Changes

**`POST /api/professional/apply`** (modified)
- Accepts new fields: `{ firstName, lastName, phone, email, address?, city?, postcode?, website?, qualifications?, currentRole?, organisation?, experience?, confirmAccuracy, confirmEthics, confirmScope }`
- All confirmation fields required (`boolean`)
- Writes to new sheet columns on row creation
- `declaration_signed_at` = ISO timestamp (captured server-side, not by client)
- If any confirmations are false → 400 error

**`GET /api/professional/apply?token=xxx`** (modified)
- Returns all form fields alongside `status`, `docsUploaded`, etc.
- Used to repopulate form on return visits

### Document Upload Behavior Change

- `doc_application` doc type is **removed** from `REQUIRED_DOC_TYPES`
- The "Application Form" PDF upload is **replaced** by the digital form submission
- Applicants still upload: training certificates, criminal check, ethics, advance care, assisted dying, fundamentals
- Upload section now appears **after** all digital form fields are filled and confirmed

### Declaration Signature

- No handwritten signature captured digitally (out of scope)
- Checkbox confirmation + timestamp in `declaration_signed_at` is sufficient
- Stripe payment confirmation serves as legal intent

### Form Validation

All fields required unless marked optional:
- `firstName`, `lastName`, `email`, `phone`
- `address`, `city`, `postcode`
- `qualifications`, `currentRole`, `organisation`
- `experience` (min 20 characters)
- `confirmAccuracy`, `confirmEthics`, `confirmScope` (must all be true)

---

## File: `src/lib/drive-files.ts` (new)

```typescript
interface DriveFile {
  fileId: string;
  applicantId: string;
  docType: DocType;
  originalFilename: string;
  uploadedAt: string;
  deleted: boolean;
}

export async function addDriveFile(...): Promise<DriveFile>
export async function softDeleteDriveFile(fileId): Promise<void>
export async function listDriveFiles(applicantId): Promise<DriveFile[]>
export async function getDriveFilesForDocType(applicantId, docType): Promise<DriveFile[]>
```

Uses same `getSheetsClient()` / `SHEET_NAME = "Drive Files"` pattern as `upload-sheet.ts`.

---

## File: `src/lib/upload-sheet.ts` (modified)

- `SHEET_HEADERS` for `Professional Applications` — add new columns F–Q
- All column letter references in `updateDocUpload`, `markComplete`, `markPaid`, `getUploadStatus`, `getApplicantByToken`, `getApplicantByEmail` — shift by +9
- `createApplicantRow` — add new fields as parameters
- `UploadStatus` interface — add new form fields

---

## File: `src/pages/api/professional/apply.ts` (modified)

- Accept new form fields in `POST` payload
- Validate confirmation checkboxes
- Write to new sheet columns
- `GET` response — return all form fields + file list

---

## File: `src/pages/api/professional/upload-file.ts` (modified)

- After upload: insert row into `Drive Files` sheet
- Remove `updateDocUpload` call (no longer needed for timestamp)
- Return `{ fileId, filename }`

---

## File: `src/pages/api/professional/delete-file.ts` (new)

- `DELETE` handler: soft-delete row in `Drive Files`, trash Drive file
- Auth: require valid `token` + verify `fileId` belongs to applicant

---

## File: `src/pages/professional/apply.astro` (modified)

- Add form sections for all new fields (layout: 2-col grid for address fields)
- Textarea for experience
- Checkboxes for confirmations
- Progressive disclosure: upload section only shown after form fields + confirmations complete
- On return visit: pre-populate all form fields from `GET /api/professional/apply` response
- Each doc type card: show list of files with delete buttons, "Add file" button
- File upload replaces `doc_application` — `REQUIRED_DOC_TYPES` excludes `application`

---

## Backwards Compatibility

**Existing applicants** (created before this change):
- `Drive Files` sheet has no rows for them — treated as having no uploaded files
- Form fields in sheet are empty — form shows blank (correct for in-progress applicants)
- Resume link still works — form loads blank fields

**Sheet header migration:**
- Old headers: `applicant_id | email | first_name | last_name | phone | resume_token | email_hash | doc_application | ...`
- New headers: shift resume_token onwards by +9 columns
- Manual step required in Google Sheets: insert 9 blank columns after `last_name` and add new headers
- OR: delete old sheet, let it re-create on next submission (loses existing applicants — acceptable for MVP)

---

## Summary of Changes

### New files
- `src/lib/drive-files.ts` — Drive Files sheet CRUD
- `src/pages/api/professional/delete-file.ts` — soft-delete endpoint

### Modified files
- `src/lib/upload-sheet.ts` — new columns, shifted indices, new fields in interfaces
- `src/pages/api/professional/apply.ts` — accept + validate new fields, write to sheet, return file list
- `src/pages/api/professional/upload-file.ts` — insert Drive Files row, return fileId
- `src/pages/professional/apply.astro` — new form sections, multi-file UI, delete buttons

### Sheet structure after change
**`Professional Applications`** (columns A–Z+):
```
A: applicant_id
B: email
C: first_name
D: last_name
E: phone
F: address
G: city
H: postcode
I: website
J: qualifications
K: current_role
L: organisation
M: experience
N: confirm_accuracy
O: confirm_ethics
P: confirm_scope
Q: declaration_signed_at
R: resume_token
S: email_hash
T: doc_application_count
U: doc_training_count
V: doc_ethics_count
W: doc_criminal_count
X: doc_advance_care_count
Y: doc_assisted_dining_count
Z: doc_fundamentals_count
AA: complete
AB: stripe_session
AC: paid
AD: created_at
AE: paid_at
```

**`Drive Files`** (new tab):
```
A: file_id
B: applicant_id
C: doc_type
D: original_filename
E: uploaded_at
F: deleted
```

---

## Manual Migration Step Required

Insert 9 columns (F–N) into the existing `Professional Applications` sheet and add the new headers before deploying. Existing rows will have empty new columns — acceptable.

---

## Testing Checklist

- [ ] Submit new application → all form fields written to correct sheet columns
- [ ] Resume link → all form fields pre-populated
- [ ] Upload 3 files to "training" category → all 3 shown with filenames + timestamps
- [ ] Delete middle file → remaining 2 still shown, deleted file gone
- [ ] "Continue to Payment" appears only when all 6 doc categories have ≥1 file
- [ ] Declaration checkboxes must all be true to proceed
- [ ] Stripe payment → webhook fires → Sheet1 logged correctly
- [ ] Existing applicant resume link still works (backwards compat)

# Professional Membership Upload & Payment System

**Date:** 2026-03-30
**Status:** Phase 1 complete | Phase 2 planned

---

## Overview

Allow Professional Membership applicants to upload required documentation before proceeding to Stripe payment. The system gates payment until all documents are confirmed, supports multi-session (applicants return over days/weeks), and treats all applicant data as sensitive.

---

## Required Documents

| Document | Notes |
|----------|-------|
| ~~Application form~~ | ~~Completed PM application form~~ → **replaced by digital form in Phase 2** |
| Certificates of training | Evidence of completed training |
| Signed ELDAA Code of Ethics and Scope of Practice | Signed document |
| Criminal records check | Background check |
| Advanced Care Planning (NZ) | 4 modules |
| Assisted Dying online training | 3 modules |
| Fundamentals of Palliative Care | 4 modules (Hospice NZ online) |

> **Phase 2 change:** The "Application Form" PDF upload is replaced by a structured digital form capturing all fields from the PDF directly.

---

## Security Architecture

### Key Principle
Email alone is never sufficient to access anything. Files are opaque blobs.

### Data Separation

| Storage | What's stored | Email present? |
|---------|---------------|----------------|
| Google Sheet | `applicant_id`, `doc_types_uploaded[]`, `complete`, `stripe_session`, `paid` | **No** |
| Server-side JSON (`.data/applicants.json`) | `applicant_id → email` mapping | **Yes** (encrypted at rest) |
| Google Drive | `/applications/{uuid}/{doc_type}/{random_filename}` | **No** |

### File Storage Rules
- Files stored under UUID paths, no email identifiers
- Original filenames NOT preserved — random filenames assigned
- Drive folder not publicly accessible
- No admin interface to view files (out of scope)

---

## Applicant Flow

### First Visit
1. Visit `/professional/apply` (no token in URL)
2. Server generates:
   - `applicant_id` (UUID v4)
   - `resume_token` (UUID v4)
3. Show registration form (name + email)

### Registration
1. Applicant enters: full name, email
2. Server:
   - Stores mapping: `applicant_id → email + resume_token` in server-side JSON
   - Creates Drive folder: `/applications/{applicant_id}/`
   - Adds row to Google Sheet: `applicant_id`, `email_hash`, `full_name`, all doc columns empty
3. **Send email** with resume link: `eldaa.org.nz/professional/apply?token={resume_token}`
4. Show document upload interface

### Document Upload
1. Applicant selects and uploads required documents
2. Each file uploaded to: `/applications/{applicant_id}/{doc_type}/{random_uuid}`
3. Sheet updated: `doc_type` column = timestamp
4. UI shows progress: "3 of 7 documents uploaded"

### Return Visit (resume)
1. Applicant opens resume link (token in URL query param)
2. Server looks up token → finds `applicant_id`
3. Show "Welcome back — 3 of 7 documents uploaded"
4. Applicant uploads remaining documents
5. No email entry required on return

### All Documents Uploaded → Payment
1. Server detects all 7 document types present
2. "Continue to payment" button appears
3. Server creates Stripe Checkout Session (same as existing flow)
4. Applicant pays → webhook confirms → sheet updated to `paid: true`
5. Success page shown

---

## Session Management

**Resume Link** — no cookies, URL token is the session.

- **Token:** `resume_token` (UUID v4)
- **Lifetime:** 30 days (or until payment complete)
- **Storage:** Server-side JSON maps `resume_token → applicant_id + email`
- **Link format:** `https://eldaa.org.nz/professional/apply?token={uuid}`

---

## Google Sheet Structure

```
Sheet: "Professional Applications" (add as new tab or separate sheet)

Phase 1 Columns:
| applicant_id | email | first_name | last_name | phone | resume_token | email_hash | doc_application | doc_training | doc_ethics | doc_criminal | doc_advance_care | doc_assisted_dying | doc_fundamentals | complete | stripe_session | paid | created_at | paid_at |

Phase 2 Columns (after first_name, last_name, phone):
| address | city | postcode | website | qualifications | current_role | organisation | experience | confirm_accuracy | confirm_ethics | confirm_scope | declaration_signed_at | (resume_token shifts to col R) |
```

- `email_hash` = SHA-256 hash of email (for deduplication without storing plaintext)
- `doc_*` columns = timestamp when uploaded, empty if not yet
- `complete` = TRUE when all doc columns filled
- `stripe_session` = checkout session ID when created
- `paid` = TRUE when webhook confirms payment

---

## File Upload to Google Drive

**Folder structure:**
```
/applications/
  └── {applicant_id}/
      ├── application/
      │   └── {random_uuid}.pdf
      ├── training/
      │   └── {random_uuid}.pdf
      ├── ethics/
      │   └── {random_uuid}.pdf
      ├── criminal/
      │   └── {random_uuid}.pdf
      ├── advance_care/
      │   └── {random_uuid}.pdf
      ├── assisted_dying/
      │   └── {random_uuid}.pdf
      └── fundamentals/
          └── {random_uuid}.pdf
```

**Upload process:**
1. Validate file type (PDF, images, docx)
2. Generate random filename
3. Upload to Google Drive via service account
4. Return success → update sheet

---

## API Endpoints

### `GET /api/professional/apply`
- Query param: `?token={resume_token}` (optional)
- If token valid: return applicant status (docs uploaded, remaining)
- If no token: return "new application" flag
- Returns: `{ status: "new" | "partial" | "complete" | "paid", docs_uploaded: [], remaining: [] }`

### `POST /api/professional/register`
- Body: `{ full_name, email }`
- Creates applicant, generates token, sends email
- Returns: `{ success: true, resume_link: "..." }`

### `POST /api/professional/upload/file`
- Body: `multipart/form-data` with file + `doc_type`
- Uploads to Drive, updates sheet
- Returns: `{ success: true, doc_type }`

### `POST /api/professional/upload/complete`
- Checks all docs uploaded
- Creates Stripe checkout session
- Returns: `{ checkout_url }`

---

## Stripe Integration

Uses existing `/api/create-professional-checkout` with:
- `mode=payment`
- `line_items` with first-term amount
- `metadata` with applicant_id, plan, etc.
- Redirects to `/professional/success?session_id=...`

Webhook handles subscription creation (existing flow).

---

## Open Questions

- [x] Resume via unique link (approved)
- [x] Use existing Google Workspace (Gmail API) for sending resume links
- [ ] Should we send email confirmation when all docs uploaded and payment ready?
- [ ] How long should we retain incomplete applications (30 days, 90 days)?
- [ ] Should there be an admin interface for staff to view upload status?
- [ ] What file size limits? (suggest 10MB per file)
- [ ] Should we support .zip uploads for bulk certificates?

---

## Files to Create

```
src/
  pages/
    professional/
      apply.astro             # Main application page (register + upload)
      success-upload.astro    # Shown after payment
      cancel-upload.astro     # Cancel page for this flow
  pages/api/
    professional/
      apply.ts                # GET - check token status, POST - register
      upload-file.ts          # Handle file upload
      upload-complete.ts      # Trigger Stripe checkout
  lib/
    drive-upload.ts           # Google Drive upload helper
    applicant-store.ts        # Server-side applicant data + token management
    upload-sheet.ts          # Sheet update helpers
    email-sender.ts          # Email sending (Gmail API via googleapis)
```

---

## Dependencies

- `googleapis` — already in use for Sheets webhook logging
- `uuid` — for applicant_id generation
- Existing Stripe, Sentry, pino logger setup

---

## Out of Scope

- Applicant downloading their own uploads (they don't need this)
- Admin interface to view files (separate authenticated system)
- Email notifications (future enhancement)
- Mobile app or native integrations

---

# Phase 2: Digital Form + Multi-File Upload

**Date:** 2026-04-01
**Status:** Planned

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
- `doc_application`, `doc_training`, etc. columns in the main sheet become informational (presence = at least one non-deleted file exists for that doc type)

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
- Progress counter changes from "N / 7" to "N of 6 categories complete" (a category is complete if ≥1 file uploaded)
- No file limit per category

### Google Sheet Changes

**`Drive Files` tab** (new):
```
Columns: file_id | applicant_id | doc_type | original_filename | uploaded_at | deleted
```
- Created on first file upload (lazy — `ensureSheetExists` pattern)
- Headers row = row 1

**`Professional Applications` tab** (existing — modify):
- `doc_application` column removed from `REQUIRED_DOC_TYPES` (replaced by digital form)
- `REQUIRED_DOC_TYPES` = `["training", "ethics", "criminal", "advance_care", "assisted_dying", "fundamentals"]`

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
T: doc_training
U: doc_ethics
V: doc_criminal
W: doc_advance_care
X: doc_assisted_dying
Y: doc_fundamentals
Z: complete
AA: stripe_session
AB: paid
AC: created_at
AD: paid_at
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

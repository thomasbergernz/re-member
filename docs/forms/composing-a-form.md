# Composing a form (for non-developers)

JimuMember's forms are split into two files:

- **`*.ts`** — owned by engineering. Defines the field *types*, validators, sheet column mapping, and any conditional logic. Treated as a contract.
- **`*.content.json`** — yours to edit. Defines the field *labels*, descriptions, placeholders, help text, and ordering. No code review required for content-only changes.

The example below is the canonical "copy me and rename" template. Start by copying `src/lib/forms/schemas/example.memberSurvey.{ts,content.json}` and editing both files.

## 1. Pick a schema id

This id is referenced from your Astro page (`loadSchema("yourId")`) and the API route (`validateTier("yourId" | tier, body)`). Keep it lowercase, kebab-cased, no spaces.

## 2. Edit the TypeScript structure (engineering)

Open `yourSchema.ts`. Walk through these decisions in order:

- **Step count.** Each `Step` represents a page in the wizard. Order them the way the user encounters them.
- **Field types.** Pick from `text | email | tel | date | number | textarea | select | radio | checkbox | repeatable | grid | group | signature`.
- **Signature field.** `type: "signature"` renders a mode toggle: **type a full name** (a plain `<input>` that posts with no JS — the accessibility fallback) OR **draw** on a canvas. A drawn signature is exported to PNG, uploaded, and its Drive link becomes the stored value — so a signature cell holds either a typed name or an `https://…` URL (both plain strings; no `serialize` rule needed). Optional props: `allowTyped` / `allowDrawn` (default both true), `uploadDocType` (default `"signature"`), `uploadEndpoint` (default `/api/advanced/upload-file`). **Drawn mode requires the host page to expose an upload endpoint and a `token`** (read from a `[name="token"]` hidden input or `window.__token__`); today only the Advanced application satisfies that. On a form without a token, set `allowDrawn: false` and the typed fallback is the whole field. Resume/hydration on a page that manages its own GET flow: call `window.__hydrateSignature__(savedValue)` after `mount()`.
- **Required fields.** Add `required: true` for fields that block submission when blank.
- **Validators.** Chain validators from `src/lib/forms/validators.ts`:
  - `required` — fails on blank
  - `email` — header-injection-safe email regex
  - `phone` — loose international phone format
  - `min(n)` / `max(n)` — numeric bounds
  - `minLength(n)` / `maxLength(n)` — string length bounds
  - `integer` — whole numbers only
  - `ynRadio` — value must be `"yes"` or `"no"` (Y/N grids and radio pairs)
  - `jsonArray` — value must parse as a JSON array (repeatable-field payloads)
  - `regex(pattern, msg)` — custom regex
  - `conditional(predicate)` — required only when a predicate returns true (e.g. only when another field equals "yes")
- **Storage.** Set `storage.sheetName` to the tab name (e.g. `"Member Survey Responses"`) and `columnMap` to map each field to a column letter (A, B, C, ...). Empty cells stay managed (set them up in the route, not the schema).
- **Uploads.** If the form accepts files, the doc-type ids + labels live in the content JSON under `uploads.docTypes` (`{ "training": "Certificates of training", ... }` — non-devs can rename labels or add types). TS keeps only the validation contract: a `DOC_TYPE_REQUIRED` map marking which ids are optional (unknown ids default to required). See `advancedApply.{ts,content.json}` for the pattern.

### Don't edit these (engineer-only)

- **Option `value`s.** `visibleWhen` predicates depend on literal values like `"yes"`. If you change a value, both client show/hide AND server validation break. Labels are fine to change; values are not.
- **Sheet column letters.** Changing a column letter silently breaks the production sheet contract.
- **Validator types.** Adding a new validator kind requires a TS-side change in `src/lib/forms/validators.ts`.

## 3. Edit the content JSON (yours)

Open `yourSchema.content.json`. Match the structure of `example.memberSurvey.content.json`:

```jsonc
{
  "title": "Member Survey",
  "description": "Tell us how your year went.",
  "steps": {
    "identity": {
      "title": "About you",
      "fields": {
        "firstName": { "label": "First name", "placeholder": "Jane" },
        "lastName": { "label": "Last name", "placeholder": "Doe" },
        "email": { "label": "Email" }
      }
    },
    "feedback": {
      "title": "Your feedback",
      "fields": {
        "rating": {
          "label": "How satisfied are you?",
          "options": {
            "very": "Very satisfied",
            "somewhat": "Somewhat satisfied",
            "notReally": "Not really"
          }
        }
      }
    }
  }
}
```

You can:

- Rename any field `label` or `placeholder`
- Add or change `help` text (shown below the input)
- Edit option `label`s (in the `options` map — the keys are stable)
- Reorder fields within a step
- Rename step `title`s

You cannot:

- Change field names (the keys must match the schema TS exactly)
- Add or remove fields (those changes live in the TS file)
- Change option `value`s (the keys in the `options` map)

## 4. Save and ship

That's it. Re-deploy — non-developers see the new copy immediately, no code review needed for content-only changes.

If you need structural changes (new field, new option, reordered steps), ask engineering to update the `.ts` file. They'll regenerate the production contract for the sheet too if column letters change.
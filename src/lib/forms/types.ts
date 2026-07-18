/**
 * Schema-driven form system — TS structure side.
 *
 * Content (labels, descriptions, option labels, ordering) lives in sibling
 * `.content.json` files. This file owns types, validators, conditional
 * predicates, sheet column mapping, and storage row factories. The compiler
 * protects those contracts; the JSON stays editable by non-developers.
 *
 * Option **values** stay here, not in JSON (see plan review finding M3):
 * a `visibleWhen: (v) => v.listOnPage === "yes"` predicate depends on the
 * literal `"yes"`. If a non-dev relabels `"yes"` → `"Yes"` in JSON, both
 * the client show/hide and the server validator break silently. So
 * `FieldOption.value` is defined in the schema (TS) and `FieldOption.label`
 * is the editable JSON-side surface.
 */

export type FieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "repeatable"
  | "grid"
  | "group"
  | "signature";

/**
 * Presentational layout for a `grid` field, authored in the content JSON.
 * Purely visual — never changes the DOM input `name`/`value` contract.
 *   table      — single-row HTML table, columns as headers (default).
 *   stacked    — one labeled row per column, always vertical.
 *   responsive — stacked on narrow screens, horizontal row ≥ breakpoint.
 */
export type GridLayout = "table" | "stacked" | "responsive";

export interface FieldOption {
  /** Stable identifier — referenced by `visibleWhen` predicates and validators. Lives in TS. */
  value: string;
  /** Human-facing label — editable in `.content.json`. */
  label: string;
  description?: string;
}

export type FieldValues = Record<string, unknown>;

export interface Validator {
  kind:
    | "email"
    | "phone"
    | "ynRadio"
    | "jsonArray"
    | "integer"
    | "minLength"
    | "maxLength"
    | "min"
    | "max"
    | "regex"
    | "required"
    | "conditional";
  value?: number | string;
  message?: string;
  /** Only for `kind: "conditional"` — predicate evaluated against the full values bag. */
  when?: (values: FieldValues) => boolean;
}

export type SerializeRule = "json" | "boolean" | "string" | "upper";

export interface BaseField {
  /** Matches FormData key on the client AND sheet column key on the server. */
  name: string;
  type: FieldType;
  /**
   * Enforced by `validate()` regardless of `validators[]` content. Acts as a
   * safety net for the common slip of pairing `required: true` with format-only
   * validators (`email`, `minLength`, etc.) that pass through blank input.
   * If `validators[]` already contains one of `required`/`conditional`/`ynRadio`/
   * `jsonArray` (kinds that themselves reject blank), that explicit validator
   * runs and its message wins. Otherwise the implicit check fires first with
   * `requiredMessage` (default "Required").
   */
  required?: boolean;
  /** Message used when the implicit required check fires. */
  requiredMessage?: string;
  defaultValue?: string | boolean | number | (() => unknown);
  validators?: Validator[];
  /** Predicate evaluated against current values to decide render-time visibility. */
  visibleWhen?: (values: FieldValues) => boolean;
  /** How the value is encoded before being written to a sheet cell. */
  serialize?: SerializeRule;
  /** Dot-path into the loaded `.content.json` for label/help/option-label lookups. */
  contentKey: string;
}

export interface TextField extends BaseField {
  type: "text" | "email" | "tel" | "date" | "number" | "textarea";
  placeholder?: string;
  autocomplete?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface SelectField extends BaseField {
  type: "select" | "radio";
  /** Option values + labels. `value` is stable (TS), `label` is editable (JSON). */
  options: FieldOption[];
}

export interface CheckboxField extends BaseField {
  type: "checkbox";
}

export interface GroupField extends BaseField {
  type: "group";
  fields: FieldDefinition[];
}

export interface RepeatableField extends BaseField {
  type: "repeatable";
  minRows?: number;
  maxRows?: number;
  itemFields: FieldDefinition[];
}

export interface GridField extends BaseField {
  type: "grid";
  columns: Array<{
    name: string;
    type: "checkbox" | "radio" | "text";
    /** Stable column id referenced by id-order serialization (plan finding m2). */
    id?: string;
  }>;
}

/**
 * Signature capture. Renders a mode toggle: type a full name (the
 * accessibility / no-JS fallback — a plain `<input name>` that posts
 * directly) OR draw on a `<canvas>`. A drawn signature is exported to PNG,
 * uploaded to `uploadEndpoint`, and the returned Drive link becomes the
 * field value. The stored value is therefore either a typed name or an
 * `https://…` URL — both plain strings, default `"string"` serialize.
 *
 * Drawn mode requires the host page to expose an upload endpoint plus an
 * identity (a `token` — read from a `[name="token"]` hidden input or
 * `window.__token__`). Today only the Advanced application satisfies that;
 * on a form without it, leave `allowDrawn: false` and the typed fallback
 * is the whole field.
 */
export interface SignatureField extends BaseField {
  type: "signature";
  /** Offer the type-a-name mode. Default true (a11y / no-canvas fallback). */
  allowTyped?: boolean;
  /** Offer the draw-on-canvas mode. Default true. */
  allowDrawn?: boolean;
  /** docType sent to the upload endpoint for the drawn PNG. Default "signature". */
  uploadDocType?: string;
  /** Endpoint the drawn PNG is POSTed to. Default "/api/advanced/upload-file". */
  uploadEndpoint?: string;
}

export type FieldDefinition =
  | TextField
  | SelectField
  | CheckboxField
  | GroupField
  | RepeatableField
  | GridField
  | SignatureField;

export interface Step {
  id: string;
  fields: FieldDefinition[];
  /** Optional step-level completion predicate (e.g. all 21 competencies ticked). */
  completeWhen?: (values: FieldValues) => boolean;
}

export interface FormContent {
  title: string;
  description?: string;
  submitLabel?: string;
  steps: Record<
    string,
    {
      title: string;
      fields: Record<
        string,
        {
          label: string;
          help?: string;
          placeholder?: string;
          /** Per-column labels for grid fields. Keyed by `FieldOption.value` / `GridColumn.name`. */
          options?: Record<string, string>;
          /**
           * Mirror of the TS schema field `type`, surfaced here so the content
           * JSON is self-describing. TS remains the source of truth — a mismatch
           * is rejected by `assertContentMatchesSchema` at load time. Optional so
           * schemas can adopt the mirror incrementally.
           */
          type?: FieldType;
          /** Grid-only presentational layout (default "table"). See `GridLayout`. */
          layout?: GridLayout;
        }
      >;
    }
  >;
}

export type RowFactory =
  | "createApplicantRow"
  | "appendRenewal"
  | "appendBasicApplication";

export interface SheetStorage {
  kind: "sheet";
  sheetName: string;
  /** Field name → column letter. Typed so a typo is caught at compile time. */
  columnMap: Record<string, string>;
  rowFactory: RowFactory;
}

export interface FormSchema {
  id: string;
  content: FormContent;
  steps: Step[];
  storage: SheetStorage;
  resume?: { tokenHeader?: string };
  uploads?: {
    docTypes: Array<{ id: string; label: string; required: boolean }>;
  };
}
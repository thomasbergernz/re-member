/**
 * Returns the staging folder-name prefix for the current environment.
 *
 * Set STAGING_PREFIX=testing- on the staging Fly app to keep staging
 * applicants visually separate from production in the shared Drive. The
 * upload + review-doc code prepends this to top-level application
 * subfolder names (e.g. "PM Applications" → "testing-PM Applications"),
 * creating an isolated subtree for staging data without touching the
 * production folders.
 *
 * Production and local dev leave the env var unset (empty string = no
 * prefix), so the existing `PM Applications` / `AM Applications` folders
 * are reused.
 */
export function getStagingPrefix(): string {
  return process.env.STAGING_PREFIX?.trim() ?? "";
}

/**
 * Returns the public base URL for the current environment.
 *
 * Used to build absolute links in outbound emails (e.g. PD-log link,
 * resume links) so they point at the app the recipient is actually on.
 *
 * Resolution order:
 *   1. PUBLIC_APP_URL — explicit override (preferred for staging/prod split)
 *   2. STAGING_PREFIX set → staging URL pattern (override via STAGING_APP_URL)
 *   3. fallback → production URL (override via PROD_APP_URL, else https://example.com)
 *
 * Production keeps no env vars. Staging sets only STAGING_PREFIX=testing-
 * and gets the staging URL automatically. Setting PUBLIC_APP_URL wins.
 */
const DEFAULT_PROD_APP_URL = "https://example.com";
const DEFAULT_STAGING_APP_URL = "https://staging.example.com";

export function getPublicAppUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return explicit;
  if (getStagingPrefix()) {
    return process.env.STAGING_APP_URL?.trim() || DEFAULT_STAGING_APP_URL;
  }
  return process.env.PROD_APP_URL?.trim() || DEFAULT_PROD_APP_URL;
}

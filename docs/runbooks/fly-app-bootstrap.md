# Runbook — Fly app bootstrap

Use this when standing up the Fly apps for a new client deployment. Run after Phase 8 (Cloudflare Worker) and before Phase 10 (GitHub Actions secrets). Cross-ref `docs/DEPLOY.md` for the full phase map.

## 1. Install + auth

```sh
brew install flyctl          # macOS
fly auth signup              # first time only
fly auth login               # subsequent
```

The Fly account is per **deploying party** (your volunteer sysadmin or agency). The Fly org is per **client** (see Phase 0 tenancy decision in `DEPLOY.md`).

## 2. Create the per-client Fly org

Pick a slug matching `<client>-member` (kebab-case, ≤ 30 chars). Example for itdocsnow.com: `itdocsnow-member`.

```sh
fly orgs create itdocsnow-member
# Default: free plan. Card on the deploying party's account bills all apps across orgs.
```

Verify: `fly orgs list` shows the new org.

## 3. Create the two apps inside the org

One app per environment. The Fly app name is the public subdomain prefix on `.fly.dev`.

```sh
# Switch into the per-client org
fly orgs switch itdocsnow-member

fly apps create itdocsnow-staging --org itdocsnow-member
fly apps create itdocsnow-production --org itdocsnow-member
```

Verify: `fly apps list --org itdocsnow-member` shows both apps.

## 4. Set the secret batch (one shot per app)

Copy the variable names from `.env.example` exactly. The `STRIPE_PRICE_*` numbering follows the tier definition order in `src/lib/forms/tiers.ts` — see the comment block at the top of that file for the N → tier-slug mapping. Phase 7 captured the four price IDs.

```sh
fly secrets set -a itdocsnow-staging \
  ORG_NAME="Your Client Display Name" \
  SUPPORT_EMAIL="membership@<client-domain>" \
  ADMIN_EMAIL="admin@<client-domain>" \
  PUBLIC_ORG_URL="https://<client-domain>" \
  PUBLIC_APP_URL="https://itdocsnow-staging.fly.dev" \
  STAGING_APP_URL="https://itdocsnow-staging.fly.dev" \
  PROD_APP_URL="https://<client-domain>" \
  STRIPE_SECRET_KEY="sk_test_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  STRIPE_PRICE_1="price_..." \
  STRIPE_PRICE_2="price_..." \
  STRIPE_PRICE_1_RENEWAL="price_..." \
  STRIPE_PRICE_2_RENEWAL="price_..." \
  GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL="remember-sheets@<gcp-project>.iam.gserviceaccount.com" \
  GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY="$(cat sa-key.json | jq -r .private_key)" \
  GOOGLE_SHEETS_SPREADSHEET_ID="<spreadsheet-id-from-phase-4>" \
  GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID="<folder-id-from-phase-4>" \
  GOOGLE_DRIVE_REVIEW_DOCS_FOLDER_ID="<folder-id-from-phase-4>" \
  GOOGLE_WORKSPACE_IMPERSONATE_USER="it-admin@<client-domain>" \
  MAILGUN_API_KEY="key-..." \
  MAILGUN_DOMAIN="mg.<client-domain>" \
  MAILGUN_FROM="Your Client <no-reply@mg.<client-domain>>"
```

Run the same block with `-a itdocsnow-production` and live Stripe keys (`sk_live_…` + the production webhook signing secret).

Verify: `fly secrets list -a itdocsnow-staging` shows ≥ 23 keys, no `value` printed.

## 5. Migration: existing app on old env-var names

If the app was previously deployed with `STRIPE_PRICE_BASIC` / `STRIPE_PRICE_ADVANCED` (or the pre-rename `STRIPE_PRICE_PROFESSIONAL` / `STRIPE_PRICE_ASSOCIATE`) — unset them, set the new ones, then redeploy:

```sh
fly secrets unset -a itdocsnow-staging \
  STRIPE_PRICE_BASIC STRIPE_PRICE_ADVANCED \
  STRIPE_PRICE_BASIC_RENEWAL STRIPE_PRICE_ADVANCED_RENEWAL \
  STRIPE_PRICE_PROFESSIONAL STRIPE_PRICE_ASSOCIATE \
  STRIPE_PRICE_PROFESSIONAL_RENEWAL STRIPE_PRICE_ASSOCIATE_RENEWAL

fly secrets set -a itdocsnow-staging \
  STRIPE_PRICE_1=... STRIPE_PRICE_2=... \
  STRIPE_PRICE_1_RENEWAL=... STRIPE_PRICE_2_RENEWAL=...
```

Then trigger a redeploy (push to main, or `fly deploy -a itdocsnow-staging --remote-only`).

Verify: `fly secrets list -a itdocsnow-staging | grep STRIPE_PRICE` shows only `STRIPE_PRICE_1`, `STRIPE_PRICE_2`, `STRIPE_PRICE_1_RENEWAL`, `STRIPE_PRICE_2_RENEWAL`.

## 6. Rollback a single secret

```sh
fly secrets unset STRIPE_PRICE_1 -a itdocsnow-staging
fly secrets set   STRIPE_PRICE_1=price_new -a itdocsnow-staging
```

Redeploy is automatic on push, manual with `fly deploy -a <app> --remote-only`.

## What's automatic

- `fly.toml` already ships with `primary_region = "syd"`, `[http_service]` health check on `/api/health` every 5m, and `auto_stop_machines = 'stop'`. No edits needed unless the client is in a different region — then override `primary_region` before first push.
- `STRIPE_PRICE_<N>` numbering is owned by `src/lib/forms/tiers.ts`. Re-ordering tiers there is a code change, not a secrets change.
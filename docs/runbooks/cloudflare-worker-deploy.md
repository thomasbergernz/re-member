# Runbook — Cloudflare Worker deploy

Use this when standing up the health-alert Worker for a new client deployment. Run after Phase 7 (Stripe) and before Phase 10 (GitHub Actions secrets). Cross-ref `docs/DEPLOY.md` for the full phase map.

## 1. Cloudflare account

The deploying party's Cloudflare account is fine to share across clients — each client gets their own Worker, deployed under the same account. If the deploying party doesn't have a Cloudflare account yet: sign up at dash.cloudflare.com (free tier is sufficient).

## 2. Rename the Worker (Phase 1)

If this is a fresh clone, Phase 1 already renamed `.run/health-alert-worker/wrangler.toml`'s `name` field. Skip if already done.

```toml
name = "itdocsnow-health-alert"   # must be globally unique across Cloudflare
```

Naming convention: `<client>-health-alert`. Avoid the historical default `remember-health-alert`.

## 3. Login + deploy

```sh
cd .run/health-alert-worker
npx wrangler login                # one-time, opens browser
npx wrangler deploy
# Output:
#   Published itdocsnow-health-alert (X.XX sec)
#   https://itdocsnow-health-alert.<account-subdomain>.workers.dev
```

Copy the deployed URL — it becomes `REMEMBER_HEALTH_ALERT_URL` in Phase 10.

## 4. Set the five secrets

```sh
# TARGET_URL: where the Worker pings
printf "%s" "https://<client-domain>/api/health" | npx wrangler secret put TARGET_URL

# TARGET_NAME: label included in Slack alerts (default: "production")
printf "%s" "production" | npx wrangler secret put TARGET_NAME

# ORG_NAME: header on Slack alerts
printf "%s" "<Client Display Name>" | npx wrangler secret put ORG_NAME

# SLACK_WEBHOOK_URL: where alerts go
printf "%s" "<slack-webhook-url>" | npx wrangler secret put SLACK_WEBHOOK_URL

# CHECK_TOKEN: bearer token for /check. Use the SAME value in GH secrets (Phase 10).
openssl rand -hex 32 | npx wrangler secret put CHECK_TOKEN
```

Save the `CHECK_TOKEN` value — Phase 10 needs it as the `REMEMBER_HEALTH_CHECK_TOKEN` repo secret. The values must match exactly.

Verify: `npx wrangler secret list` shows all five.

## 5. Smoke test

```sh
# Without token — expect 401
curl -i https://itdocsnow-health-alert.<sub>.workers.dev/check

# With token — expect 200 + {"checked":1,"failed":0|"failed":1}
curl -X POST -H "Authorization: Bearer $CHECK_TOKEN" \
  https://itdocsnow-health-alert.<sub>.workers.dev/check | jq
```

If the deploy's `TARGET_URL` is reachable and returns `{status:"ok"}`, `failed` is 0. If it returns `degraded` or times out, `failed` is 1 and a Slack alert fires.

## 6. Slack webhook

If the client doesn't have a Slack workspace yet, create one at slack.com (free). Add an incoming-webhook integration under **Apps → Incoming Webhooks → Add to Slack**, copy the URL. The webhook URL is per-channel — make sure the right channel receives the alerts.

## What's automatic

- Worker code (`worker.mjs`) is generic — no client-specific logic, only the secrets differ.
- The GH cron (`.github/workflows/health-check.yml`) calls the Worker every 5 min + on manual trigger. It uses `REMEMBER_HEALTH_CHECK_TOKEN` from Phase 10's secrets.

## Rollback

```sh
npx wrangler rollback              # revert to previous deployment
npx wrangler secret put CHECK_TOKEN   # rotate the token (also update GH secret)
npx wrangler delete                # last resort
```
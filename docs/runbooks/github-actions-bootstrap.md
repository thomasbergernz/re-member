# Runbook — GitHub Actions bootstrap

Use this when setting up CI/CD for a new client deployment. Run after Phase 9 (Fly secrets) and before Phase 12 (first deploy). Cross-ref `docs/DEPLOY.md` for the full phase map.

## 1. Fork the repo (or use the deploying party's fork)

If the client needs their own fork: fork `github.com/thomasbergernz/re-member` (or the deploying party's fork) under the client's org. Clone their fork locally. Push all Phase 1-11 changes to the client's fork first.

Verify: `git remote -v` shows the client's fork as `origin`, the blueprint upstream as `upstream`.

## 2. Fly API token

`fly auth token` is deprecated as of `flyctl` 0.3.x. Use `fly tokens create org` instead — produces an org-scoped token that can't impersonate other orgs' apps.

```sh
fly tokens create org <org-slug>
# Output: Fo1_xxxxxxxxxxxxxxxxxxxxx...
```

Add as a **classic PAT** to the GH org at **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `FLY_API_TOKEN`
- Value: the token from above

Scope: org-level or repo-level. Org-level means the same token works for all client deployments in the org — convenient, but consider rotating more often.

## 3. Health-check token

Use the same value as `CHECK_TOKEN` from Phase 8 (Cloudflare Worker).

- Name: `REMEMBER_HEALTH_CHECK_TOKEN`
- Value: the 32-byte hex string from `openssl rand -hex 32`

## 4. Health-alert URL

- Name: `REMEMBER_HEALTH_ALERT_URL` (this is a **variable**, not a secret)
- Value: `https://<client>-health-alert.<account-subdomain>.workers.dev` (from Phase 8)

## 5. Production environment

`.github/workflows/fly-deploy.yml` uses `environment: production`. Configure the environment at **Settings → Environments → New environment → production**:

- Required reviewers: optional. Add reviewers if the client wants a sign-off gate before each prod deploy.
- Secrets: none needed beyond `FLY_API_TOKEN` (which is already org-level).
- Deployment branches: restrict to `main` (default).

The `fly-deploy-staging.yml` workflow has no environment — staging deploys are automatic on every push to `main`.

## 6. Verify the workflows

```sh
gh workflow list
```

Expect three workflows:
- `fly-deploy-staging.yml` — auto on push to `main`
- `fly-deploy.yml` — manual via `workflow_dispatch`
- `health-check.yml` — every 5 min cron + manual

Trigger a no-op deploy to confirm everything wires:

```sh
gh workflow run fly-deploy-staging.yml --ref main
gh run watch
```

Expect: green run, new staging image pushed to Fly.

## What's automatic

- `fly-deploy-staging.yml` already references `--app remember-staging`. Phase 1 renamed it to `<client>-staging`.
- `fly-deploy.yml` already references `--app remember-production`. Phase 1 renamed it to `<client>-production`.
- `health-check.yml` reads `REMEMBER_HEALTH_CHECK_TOKEN` + `REMEMBER_HEALTH_ALERT_URL` from repo secrets + variables.

## Rollback

| Issue | Fix |
|---|---|
| `FLY_API_TOKEN` expired | `fly tokens create org <org>` → update GH secret → re-run workflow |
| `REMEMBER_HEALTH_CHECK_TOKEN` rotated | update Worker `CHECK_TOKEN` (Phase 8) + GH secret to the same new value |
| Production deploy blocked | approve the environment in GH Actions UI, or remove required reviewers |
| Staging deploy broken | check `gh run logs --job=<id>` — most common cause is missing `FLY_API_TOKEN` |
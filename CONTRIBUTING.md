# Contributing to JimuMember

Thanks for helping. This is a small project run by volunteers' spare time — the conventions below exist to keep review fast.

## Dev setup

```sh
npm install
cp .env.example .env   # fill in test-mode credentials, or leave blank for dry-run
npm run dev
```

You don't need real Stripe/Google credentials for most work: dry-run mode and the E2E stubs (`E2E_STUB=1`) neutralise external calls.

## Tests — all three must pass

```sh
npm run check      # astro check + typecheck
npm test           # vitest unit suite
npm run test:e2e   # Playwright smoke (builds + previews with E2E_STUB=1)
```

CI runs the same three on every PR. Note: Playwright cannot intercept server-side Stripe/Sheets/Mailgun calls — the env-gated server shims exist for that; don't try `page.route()`.

## Conventions that will trip you up otherwise

- **Specs and REQ-IDs.** Domain behaviour is specified under `spec/`. Reference REQ-IDs in commits: `feat(001): REQ-AA-003 implement Y/N grid`. IDs are stable — never reuse or renumber.
- **Form content vs schema.** Labels/options text live in `*.content.json` (editable per-org); option **values** live in the TypeScript schema. Never move option values into JSON — `visibleWhen` predicates and server validation depend on them.
- **Schema-driven form styling** lives in `src/styles/global.css` (`@layer components`) — fix shared CSS, don't bolt per-page styles.
- **Route renames** must sweep inline-script literals, Stripe redirect URLs, `<a href>`s and logger strings — the stale-path guard test will catch residue.

## Pull requests

Fill in the PR template, including the verification checklist. Runtime changes that touch a real external boundary (Stripe, Sheets, Drive, email) need live proof — a test-mode payment, staging run, or dry-run log — not just green mocks.

Small, bounded PRs land fastest. For anything design-shaped, open an issue first.

## Security

See [SECURITY.md](SECURITY.md) — never report vulnerabilities in public issues.

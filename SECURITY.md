# Security Policy

JimuMember moves money (via Stripe) and handles member personal data (via Google Workspace), so we take reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting: **Security tab → Report a vulnerability** on this repository. You'll get an acknowledgement within a few days.

Please include reproduction steps and affected flow (signup, application, renewal, webhook, uploads). Redact any real member data.

## Scope notes

- Card data never touches this codebase — payment is Stripe-hosted Checkout. Findings about Stripe itself go to Stripe.
- Each deployment is an independent fork with its own credentials; a vulnerability here likely affects all forks, which is exactly why we want it privately first.
- Secrets live in environment variables / platform secret stores. A report that a *deployment* leaked its own secrets belongs with that deployment's operator.

## Supported versions

The `main` branch and the latest tagged release. Forks that have diverged should port fixes forward themselves — subscribe to Releases and security advisories.

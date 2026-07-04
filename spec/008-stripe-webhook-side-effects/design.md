# Design — Stripe Webhook Side Effects

> Spec ID: `008` · Type: system feature
> Depends on: `000-platform-overview`, `005-membership-renewal`, `007-stripe-checkout-flow`, `009-email-notifications`, `010-admin-application-review`

## Overview

Single endpoint, signature-verified, dispatch by metadata.flow. Idempotent via event ID cache. Synchronous sheet update; async doc + email.

## Component Design

1. **`src/pages/api/stripe-webhook.ts`** — handler. Verifies signature, dispatches by event type + flow.
2. **`src/lib/memberships.ts`** — durable subscription-state mirror in the `Memberships` sheet tab (Stripe-authoritative; see spec 000 sheet contracts). Status setters are upserts: a missing row is created partially populated and logged (`membership_upsert_on_missing`), never silently dropped. Per-customer write serialisation (promise chain; per-process — revisit before multi-machine scale-out).
3. **`src/lib/renewal-sheet.ts`** — `markRenewalPaid()`.
4. **`src/lib/google-docs.ts`** — `createApplicationReviewDoc()`.
5. **`src/lib/email-sender.ts`** — confirmation + admin notification emails.

## Dispatch Logic

```typescript
async function handleEvent(event: Stripe.Event) {
  if (processedEvents.has(event.id)) return { received: true };  // idempotent
  processedEvents.add(event.id);

  switch (event.type) {
    case 'checkout.session.completed':
      const flow = event.data.object.metadata.flow;
      if (flow === 'option_c') await handleOptionC(event);
      else if (flow === 'renewal') await handleRenewal(event);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoicePayment(event);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdate(event);
      break;
  }
  return { received: true };
}
```

## Flow Handlers

### Option C (application)

```
checkout.session.completed (metadata.flow = 'option_c')
   │
   ▼
lookup applicant by metadata.applicant_id
   │
   ▼
sync: setApplicantPaid(applicantId, event.id)  // AP='TRUE', AR='TRUE', AT=now
   │
   ├─async─► createApplicationReviewDoc(applicant)
   │
   ├─async─► getMembership() + setAwaitingSubscription(applicantId, recurring_price_id)
   │
   └─async─► sendConfirmation(applicant) + sendAdminNotification(applicant)
```

### Renewal

```
checkout.session.completed (metadata.flow = 'renewal')
   │
   ▼
lookup renewal by metadata.renewal_id
   │
   ▼
sync: markRenewalPaid(renewal_id, amountPaidCents, event.id)  // K='paid', N=now
   │
   ├─async─► sendAdminNotification(renewal)
   │
   └─async─► if tier === 'adv': sendPdLogLink(renewal)
```

### Auto-renewal (Option C, year 2+ — REQ-MR-009/010, REQ-SW-008)

The deferred subscription's trial ends at the anchor date; Stripe charges the
saved card and emits `invoice.payment_succeeded`. Auto-renewals join the
manual-renewal rails: one Renewals ledger, machine- and member-created rows
side by side. `flow`/`plan` are resolved from the SUBSCRIPTION's metadata
(via the invoice's `parent.subscription_details` snapshot, retrieval
fallback) — Stripe does not propagate subscription metadata to
`invoice.metadata`, which is why the previous handler was dead code.

```
invoice.payment_succeeded
   │
   ▼
billing_reason != subscription_cycle ─► skip (log reason)
amount_paid == 0                     ─► skip
resolve subscription → metadata.flow != option_c ─► skip
   │
   ▼
getRenewalByStripeRef(invoice.id) exists? ─► skip (idempotent replay)
   │
   ▼
sync: appendRenewal({ …, payment_status:'paid', stripe_session: invoice.id })
   │
   ├─async─► sendRenewalAdminNotification(renewal)
   ├─async─► if tier === 'adv': sendRenewalPdLogLink(renewal)
   ├─async─► setActive(customerId, sub.id, invoice.id)   // durable mirror
   └─(016)─► recordPaymentInXero(payment)                // when adapter lands
```

Handle `invoice.payment_succeeded` ONLY — never also `invoice.paid` (fires
additionally for out-of-band payments; two subscriptions means every renewal
processed twice). Keep the Stripe dashboard endpoint's event list in sync.

## Idempotency

In-memory `Set<string>` of event IDs. Per-process; resets on restart. Replays within a single process are deduped. Cross-restart replays re-process (acceptable; side effects are designed to be re-runnable).

## Error Handling

- Sheet update failure → log + return 500 (Stripe retries).
- Email/doc failure → log + return 200 (don't retry forever).
- Signature mismatch → 400 immediately.

## Testing Strategy

- `stripe-webhook.test.ts` — signature verification, dispatch, idempotency
- Per-flow handler tests with Stripe event fixtures

## Risks

- Sheet rate limits: 60 writes/min per service account. Mitigation: batch + retry.
- Async side effects lost on deploy: log + accept (idempotent re-runnable).

## Future Considerations

- Persistent event ID store (Sheets or KV)
- Dead-letter queue for failed side effects
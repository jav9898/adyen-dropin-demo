# Adyen Sessions + Drop-in Integration — Project Overview

Built for the Implementation Engineer case study: a working demo of an Adyen online payments integration using the Sessions flow and Web Drop-in, covering the full payment lifecycle from checkout through capture, cancellation, and refund.

## What this demonstrates

Rather than a minimal "hello world" payment, this project intentionally covers the parts of a real integration that are easy to gloss over in a demo but matter in production:

- A **working end-to-end payment flow** — session creation, Drop-in checkout, webhook confirmation, and result display
- **Post-authorization payment modifications** — capture, cancel, and refund, each with correct async webhook handling
- **Reliability engineering**, not just happy-path code: idempotent retries, HMAC-verified webhooks, and webhook deduplication
- **Global readiness**: all 138 currencies Adyen supports, each with correct minor-unit handling (not just the common 2-decimal case)
- A **security-conscious architecture**: the Adyen API key never leaves the backend; the frontend only ever sees a public client key and a single-use encrypted session token

## Quick orientation

| If you want to... | Look at |
|---|---|
| Run it yourself | `setup.sh`, `QUICK_START.md` |
| See the full technical walkthrough (as if presenting to a customer) | `adyen-dropin-sessions-technical-walkthrough.md` |
| Understand the codebase in depth (line-by-line reasoning) | `implementation.md` |
| Test it manually | `TESTING_GUIDE.md`, `POSTMAN_COLLECTION...` |
| See the original case study brief | `requirement.md` |

## Architecture at a glance

```
Browser (Drop-in)  ⇄  Backend (Express)  ⇄  Adyen API
                            ⇅
                      Webhook receiver
```

- **`frontend/index.html`** — single-page checkout UI. Adyen Web is loaded via a real `npm import` (not a CDN script tag), served statically by `http-server` with no bundler — the package's own dist files use only relative internal imports, so this works without Vite/Webpack.
- **`backend/server.js`** — the only component holding the Adyen API key. Creates sessions, requests captures/cancels/refunds, and is the single receiver for Adyen's webhooks.

## What's actually implemented

**Core payment flow**
- Session creation → Drop-in checkout → webhook-confirmed result, with PSP reference, merchant reference, and amount all correctly resolved (not just the provisional client-side callback data)

**Post-authorization actions**
- Capture, Cancel, and Refund, each calling the correct Adyen endpoint (`ModificationsApi`) and correctly waiting on the corresponding webhook (`CAPTURE`, `CANCELLATION`, `REFUND`) rather than trusting the synchronous "received" response as final
- UI enforces the real business constraint that a captured payment can only be refunded, not cancelled

**Reliability**
- Idempotency: every mutating Adyen call uses a UUIDv4 key generated once per logical request, with automatic retry on Adyen's documented transient-error conditions (`transient-error: true` header, or error code 704)
- Webhook deduplication: keyed on `eventCode:pspReference` exactly as Adyen's own docs specify, so a redelivered webhook is acknowledged without being reprocessed
- HMAC signature verification on every incoming webhook, using `@adyen/api-library`'s `hmacValidator` — verified against the actual library source rather than assumed

**Global scale**
- Full 138-currency list sourced directly from Adyen's currency codes documentation, with correct minor-unit conversion per currency (0-decimal currencies like JPY, 3-decimal currencies like BHD, and everything in between)
- `countryCode` and `channel` correctly parameterized on session creation, since these — not client-side logic — are what actually filter available payment methods

## Deliberate scope boundaries

Worth being upfront about what this demo does *not* do, since a real interview conversation should distinguish "didn't get to it" from "didn't think of it":

- **In-memory state** (`Map`) for sessions and webhook tracking — fine for a single-process demo, would need a real database to survive a restart or scale across multiple server instances
- **No transport-level webhook auth** (Basic Auth/OAuth) configured — HMAC verification is the actual security control in place; transport auth was a deliberate trade-off discussed during build, not an oversight
- **Pending payment state** — the four lifecycle states named in the brief (authorised, pending, failed, cancelled) are all understood and explainable, though the UI's distinct handling for "pending" specifically wasn't built out
- **Pre-authorization (PreAuth) was investigated, then descoped** — implemented, tested, then removed once it became clear this project's scope didn't need it; the investigation itself (including verifying whether Adyen's docs actually confirm PreAuth support via `/sessions` vs. only the Advanced flow) is documented in the technical walkthrough

## Tech stack

- **Backend**: Node.js, Express, `@adyen/api-library`
- **Frontend**: Vanilla JS, Adyen Web (`@adyen/adyen-web`) via npm — no framework, no bundler
- **Testing**: Postman collection, manual test script (`TESTING_GUIDE.md`)
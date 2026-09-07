# Adyen Sessions Integration — Implementation Guide

A walkthrough of this project's payment integration, for onboarding someone else onto the codebase. Covers the checkout UI, end-to-end flow, architecture, payment lifecycle, reliability, and scaling considerations — all referencing the actual code in `frontend/index.html` and `backend/server.js`.

---

## 1. Which part of the code pulls the checkout UI / payment methods from Adyen?

Nothing in this codebase hardcodes a payment method list. The checkout UI and the set of available payment methods are both **fetched live from Adyen**, driven by two pieces of code working together:

> **Terminology note:** Adyen's own docs call this the **"Adyen Web library"** (npm package `@adyen/adyen-web`), with **"Drop-in"** referring specifically to the pre-built UI component inside it. The docs reserve the word "SDK" for other things — e.g. the mobile 3D Secure 2 SDK, or the generic `Checkout SDK` label used in the `applicationInfo.adyenPaymentSource` API field. This guide uses "Adyen Web library" throughout to match that.

**a) The Adyen Web library itself** (loaded in `index.html`):

```javascript
const script = document.createElement('script');
script.src = `https://checkoutshopper-test.adyen.com/checkoutshopper/sdk/${ADYEN_SDK_VERSION}/adyen.js`;
```

This is Adyen's Drop-in library (`window.AdyenWeb`). It contains the actual UI components (card form, iDEAL button, etc.) — none of that markup lives in our code.

**b) `initializeAdyenCheckout()`**, which creates a Drop-in instance:

```javascript
const { AdyenCheckout, Dropin } = window.AdyenWeb;
checkoutInstance = await AdyenCheckout(configuration);
dropinInstance = new Dropin(checkoutInstance, dropinConfiguration).mount('#dropin-container');
```

When `AdyenCheckout(configuration)` runs, it internally calls Adyen's `/sessions`-linked payment methods lookup using the `session.id` / `session.sessionData` we pass in. **This is the actual "pull" — it happens inside the Adyen Web library, not in our code.** The library returns a `paymentMethodsResponse` and Drop-in renders whatever comes back.

**What determines which methods come back?** Not our frontend — it's decided server-side by Adyen based on parameters we send when creating the session (see `server.js`):

```javascript
const createCheckoutSessionRequest = {
  merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
  amount: { value: amount || 1000, currency: currency || 'EUR' },
  countryCode: countryCode || 'NL',
  channel: 'Web',
  ...
};
```

`countryCode`, `currency`, and `channel` filter the list against whatever payment methods are enabled for the merchant account in the Adyen Customer Area. Our `<select id="country">` / `<select id="currency">` dropdowns in the HTML form are the only "control" our code has over this — everything else is Adyen's decision.

---

## 2. End-to-end payment flow

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│ Frontend │───1───▶│ Backend  │───2───▶│  Adyen   │
│  (HTML)  │◀──3────│(Express) │◀──────-│   API    │
└──────────┘        └──────────┘        └──────────┘
     │                    ▲                   │
     │                    │                   │
     4  (Drop-in UI,      6 (async webhook)────5
     shopper pays)        │
     │                    │
     ▼                    │
  Adyen Web library ─────────
  (redirect/3DS if needed)
```

**Step-by-step, matching actual functions:**

1. **Shopper fills the form → `createSession()`** (`index.html`)
   Sends `amount`, `currency`, `countryCode`, `reference`, etc. to our backend via `fetch(POST /api/sessions)`.

2. **Backend calls Adyen → `checkoutAPI.PaymentsApi.sessions(...)`** (`server.js`, `/api/sessions` route)
   Server-side call to Adyen's `POST /sessions`, using the secret API key (never exposed to the browser). Adyen responds with `{ id, sessionData, amount, reference, ... }`.

3. **Backend returns session data to frontend.**
   `createSession()` stores this as `currentSessionData` / `currentSessionId`.

4. **Frontend initializes Drop-in → `initializeAdyenCheckout()`**
   Fetches the client key from `GET /api/config`, then creates `AdyenCheckout(configuration)` and mounts Drop-in. The shopper enters card details and pays. For methods requiring 3D Secure or redirect (iDEAL, etc.), the Adyen Web library handles the redirect and return automatically.

5. **Adyen processes the payment** and, once authorised (or failed), sends an **asynchronous webhook** — not a synchronous API response — to our backend.

6. **Backend receives it at `POST /api/webhooks`**, parses `notificationItems`, and updates the in-memory `paymentStore` keyed by session ID. This is the **only authoritative source** for `pspReference`, final status, etc. — the synchronous `onPaymentCompleted` callback in step 4 only gives a provisional `resultCode`.

7. **Frontend polls for the outcome → `pollForPspReference()`**
   Since the webhook arrives asynchronously and may take several seconds, the frontend polls `GET /api/sessions/:id` every second (up to a configured window) until `webhookData.pspReference` appears, then renders the final result via `renderPaymentDetails()`.

---

## 3. System architecture

**Three components, three responsibilities, two trust boundaries:**

| Component | Responsibility | Trust level |
|---|---|---|
| **Drop-in (Adyen Web library, runs in browser)** | Renders payment UI, collects/encrypts card data client-side, handles 3DS/redirect flows | Untrusted — runs on the shopper's machine |
| **Our backend (`server.js`)** | Holds the Adyen API key, creates sessions, requests captures/cancels, receives webhooks, is the source of truth for payment state | Trusted — the only thing allowed to talk to Adyen with real credentials |
| **Adyen's platform** | Processes the actual payment, generates `pspReference`, sends webhooks | External trusted third party |

**Why this split matters (security boundary):**

The `ADYEN_API_KEY` **never appears in the browser** — it only exists in `backend/.env`, read via `process.env.ADYEN_API_KEY` inside `server.js`. The frontend only ever receives:
- The `clientKey` (a public, restricted key safe for browser use) via `GET /api/config`
- The `sessionData` blob (encrypted, single-use, tied to one session)

This is exactly why the **Sessions flow** exists as opposed to the older Advanced flow: card data is encrypted client-side by the Adyen Web library before it ever leaves the browser, and the only thing our backend touches is Adyen's session/modification APIs — never raw card numbers.

**Data flow for state:**

```javascript
const paymentStore = new Map();       // sessionId -> full payment state
const pspReferenceIndex = new Map();  // pspReference -> sessionId
```

This in-memory store is explicitly marked in the code as a demo simplification (`// Store for demo purposes (in production, use a real database)`). In a real deployment this would be a database (Postgres, DynamoDB, etc.) — the in-memory Map doesn't survive a server restart and doesn't work across multiple server instances (see Section 6).

---

## 4. Payment lifecycle and webhook-based updates

Adyen payments move through states that our code tracks via **webhook event codes**, not API response codes (the API response only ever confirms "request received," never the final outcome):

| State | How it's detected in code | Where |
|---|---|---|
| **Created** | Session created, `status: 'created'` set manually | `POST /api/sessions` handler |
| **Authorised / Failed** | `AUTHORISATION` webhook, `item.success === 'true'` or `'false'` | `POST /api/webhooks`, `if (item.eventCode === 'AUTHORISATION')` |
| **Pending** | `resultCode` from Drop-in's `onPaymentCompleted`/`onPaymentFailed` can be `Pending`, `Received`, or `PresentToShopper` for async methods — handled generically since `renderPaymentDetails()` just displays whatever `resultCode` string comes back | `index.html`, `handlePaymentResult()` |
| **Captured / Capture failed** | `CAPTURE` webhook | `POST /api/webhooks`, `else if (item.eventCode === 'CAPTURE' ...)` |
| **Cancelled / Cancel failed** | `CANCELLATION` webhook | Same block, `statusField = 'cancelStatus'` |

**Why webhooks and not the API response:** every Adyen modification endpoint (`/sessions`, `/captures`, `/cancels`) returns immediately with `status: "received"` — that only confirms Adyen *accepted* the request, not that it *succeeded*. The real outcome is delivered later via webhook. This is why the code has two matching indices in `paymentStore`:

- `checkoutSessionId` → used to match the original `AUTHORISATION` webhook back to a session
- `originalReference` (= the payment's `pspReference`) → used to match later `CAPTURE`/`CANCELLATION` webhooks back to the same session, since those webhooks don't carry `checkoutSessionId`

```javascript
// on AUTHORISATION:
if (item.pspReference) {
  pspReferenceIndex.set(item.pspReference, sessionId);
}
// on CAPTURE / CANCELLATION:
const sessionId = pspReferenceIndex.get(item.originalReference);
```

**Frontend side — bridging the async gap:** `pollForPspReference()` and `pollForModificationOutcome()` both poll the backend every second for up to a configured window (60s for capture/cancel), since the webhook can take anywhere from under a second to nearly a minute depending on network conditions (this was empirically observed with ~48s delivery time over an ngrok tunnel during testing). A manual **"Check status now"** button exists as a fallback if the poll window expires before the webhook arrives.

---

## 5. Reliability: retries, idempotency, and duplicate/delayed webhooks

### 5.1 Idempotency (attached docs)

Per the Adyen idempotency docs you attached: **POST requests support an `idempotency-key` header**, letting you safely retry a request (e.g. after a timeout) without Adyen performing the action twice. Every mutating call in `server.js` already sets this:

```javascript
// Session creation
{ idempotencyKey: `session-${Date.now()}` }

// Capture
{ idempotencyKey: `capture-${pspReference}-${Date.now()}` }

// Cancel
{ idempotencyKey: `cancel-${pspReference}-${Date.now()}` }
```

**Caveat worth flagging to whoever you're onboarding:** `Date.now()` is not a great idempotency key generator on its own — if a request is retried by re-invoking the same function (rather than literally resending the exact same HTTP request with the same key), a new timestamp produces a *new* key, defeating the purpose. The Adyen docs explicitly recommend **UUIDv4** for real retry safety:

> "Generate unique idempotency keys per request using the version 4 (random) UUID type"

For genuine retry-safety (e.g. wrapping the capture call in a retry loop on network failure), the key should be generated **once per logical request** and reused across all retry attempts of that same request — not regenerated each attempt.

### 5.2 Duplicate webhooks

Adyen's webhook docs note that Adyen may redeliver a webhook if it doesn't receive our `[accepted]` response quickly enough. **This code does not currently deduplicate.** If the same `AUTHORISATION` webhook arrives twice, the current handler would just overwrite `session.status` with the same value twice — harmless for this particular field, but worth noting explicitly as a gap: there's no check like `if (session.webhookData?.pspReference === item.pspReference) return;` to skip reprocessing. For a production system, you'd typically deduplicate on `pspReference` + `eventCode`, or check `hmacSignature` validation (also not currently implemented — the code doesn't verify the webhook signature against `ADYEN_HMAC_KEY`, meaning **any POST to `/api/webhooks` is currently trusted without verification**, which is a real gap to flag).

### 5.3 Response speed to Adyen

The webhook handler responds `200` at the very end, after all processing:

```javascript
res.status(200).json({ received: true });
```

Adyen expects a fast `[accepted]`-style acknowledgment (within seconds) — slow processing inside the handler risks Adyen treating it as failed delivery and retrying, which compounds the duplicate-webhook risk above. Since the current handler does simple synchronous Map writes, this isn't a practical issue yet, but it would become one if webhook processing grew more complex (e.g. a real DB write with contention).

### 5.4 Frontend retry/polling resilience

`pollForPspReference` / `pollForModificationOutcome` implement a simple fixed-interval poll (1 request/second) rather than exponential backoff — acceptable for a short-lived UI wait, but the Adyen docs' guidance on **exponential backoff** is specifically about retrying *API calls themselves* under load/rate-limiting, not UI polling for webhook arrival — worth distinguishing when explaining this to someone, since they're solving different problems.

---

## 6. Global scaling: multi-country, multi-payment-method, multi-currency

The current code already threads country/currency through per-request rather than hardcoding it, which is the right foundation — but there are gaps to flag for real global scale:

**What's already parameterized:**
```javascript
countryCode: countryCode || 'NL',
amount: { value: amount || 1000, currency: currency || 'EUR' },
```
Both come from the frontend form and flow straight into the session request — no hardcoded single-market assumption.

**What would need to change for true multi-region scale:**

1. **Live endpoint region.** The docs note multiple live environments (`live`, `live-us`, `live-au`, `live-nea`, `live-in`) — a single `ADYEN_ENVIRONMENT=test` env var works for test, but a global deployment needs environment/region selection logic, since API requests for the same payment must stay in the same region (mixing regions on `/payments` vs `/payments/details` "may result in errors").

2. **In-memory store doesn't scale horizontally.** `const paymentStore = new Map()` lives in one process's memory. Running multiple backend instances (needed for real traffic) means each instance has a different, incomplete view of sessions — a webhook landing on instance B for a session created on instance A would fail to find it. This needs to move to a shared datastore (Redis/Postgres) before horizontal scaling is possible.

3. **Idempotency keys need to be globally unique**, per the attached docs ("Keys are stored at a company account level... unique to the company account") — the current `Date.now()`-based keys are a collision risk at meaningful scale (two requests in the same millisecond).

4. **Webhook endpoint needs to handle regional webhook delivery** — if using multiple merchant accounts per region, the webhook handler currently assumes a single `ADYEN_MERCHANT_ACCOUNT` (`process.env.ADYEN_MERCHANT_ACCOUNT`), but `item.merchantAccountCode` is already present in every webhook payload and isn't currently validated against it — worth adding a check that incoming webhooks actually belong to the expected merchant account(s), especially once there's more than one.

5. **Payment-method availability isn't currently constrained by `allowedPaymentMethods`/`blockedPaymentMethods`** (see Section 1) — at scale across many countries, some merchants deliberately curate the method list per market (e.g. hiding a method that has poor conversion in a specific country) rather than relying purely on Adyen's automatic country-based filtering. That's a config-driven addition, not a rewrite.

6. **Currency-specific minor units.** The code assumes `value` is always in the standard minor-unit format (cents). Some currencies (JPY, KRW) have zero minor units, and others (BHD) have three — a global rollout needs a currency-aware amount formatter rather than the current `(value / 100).toFixed(2)` used in `renderPaymentDetails()`, which is hardcoded to a 2-decimal, 100-minor-units assumption.

---

## Quick reference: file → responsibility map

| File | Contains |
|---|---|
| `backend/server.js` | All Adyen API calls, webhook receiver, in-memory state store, the only place holding `ADYEN_API_KEY` |
| `frontend/index.html` (script 1) | Adyen Web library loader with version/domain pinning and diagnostic error logging |
| `frontend/index.html` (script 2) | Session creation, Drop-in mounting, result rendering, capture/cancel actions, all polling logic |
# Adyen Sessions Flow Integration Demo
A comprehensive demonstration of the Adyen Sessions flow integration using Web Drop-in, showcasing the complete payment lifecycle from session creation through capture, cancellation, refund, and webhook handling.

## 🎯 Demo Overview
This demo demonstrates:
- **Real Adyen API Integration**: Uses actual Adyen test credentials to run real payment flows
- **Complete Payment Lifecycle**: Session creation → payment processing → webhook handling → capture/cancel/refund → result verification
- **Frontend + Backend Architecture**: Separate Node.js servers for frontend and backend
- **Reliability Engineering**: Idempotent retries, HMAC-verified webhooks, and webhook deduplication — not just the happy path
- **Global Currency Support**: All 138 currencies Adyen supports, each with correct minor-unit handling
- **API Response Inspection**: Complete logging and tracking of all API interactions
- **Payment Status Tracking**: Real-time monitoring of payment status changes through API responses and webhooks

## 🏗️ Architecture
```
┌─────────────────┐     HTTP Request     ┌─────────────────┐
│   Frontend      │ ───────────────────> │   Backend       │
│   (Port 8080)   │                      │   (Port 3001)   │
└─────────────────┘                      └─────────────────┘
                                                 │
                                                 │ Adyen API
                                                 ▼
┌─────────────────┐                     ┌─────────────────┐
│   Adyen Drop-in │                     │   Adyen API     │
│   (via npm)     │                     │   (Checkout)    │
└─────────────────┘                     └─────────────────┘
                                                 │
                                                 │ Webhook (HMAC-verified,
                                                 │ deduplicated)
                                                 ▼
┌─────────────────┐                     ┌─────────────────┐
│   Payment       │ <────────────────── │   Backend       │
│   Result Page   │                     │   Webhook       │
└─────────────────┘                     └─────────────────┘
```

The Adyen Web library is installed via **npm** (`@adyen/adyen-web`) and imported as a real ES module — not loaded from a CDN. Its dist files use only relative internal imports, so `http-server` can serve `node_modules` statically and the browser resolves everything natively, with no bundler required.

## 📋 Requirements
- Node.js 18 or later
- Adyen test account credentials:
  - API Key
  - Merchant Account
  - Client Key
  - HMAC Key (for webhook signature verification — generated in the Customer Area)
- npm or yarn

## 🚀 Quick Start
### 1. Clone and Setup
```bash
# Navigate to project directory
cd /Users/javierdoong/test2
# Install backend dependencies
cd backend
npm install
# Install frontend dependencies
cd ../frontend
npm install
npm install @adyen/adyen-web
```
### 2. Configure Environment
```bash
# Copy environment template
cd backend
cp .env.example .env
# Edit .env with your Adyen credentials
nano .env
```
Update the following values in `backend/.env`:
```env
ADYEN_API_KEY=your_actual_adyen_api_key
ADYEN_MERCHANT_ACCOUNT=your_merchant_account_name
ADYEN_CLIENT_KEY=your_client_key
ADYEN_HMAC_KEY=your_hmac_key
ADYEN_ENVIRONMENT=test
```
> **Note:** without `ADYEN_HMAC_KEY` set, the backend fails closed and rejects all incoming webhooks — this is intentional (see Security Considerations below), not a bug.

### 3. Start the Servers
```bash
# Terminal 1: Start backend server
cd backend
npm run dev
# Terminal 2: Start frontend server
cd frontend
npm start
# Terminal 3 (for webhook testing): expose the backend publicly
ngrok http 3001
```
### 4. Access the Demo
- **Frontend**: http://localhost:8080
- **Backend API**: http://localhost:3001
- **Health Check**: http://localhost:3001/health

## 🔧 API Endpoints
### Backend Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check endpoint |
| GET | `/api/config` | Get Adyen configuration (client key, environment) |
| POST | `/api/sessions` | Create a new payment session |
| GET | `/api/sessions/:sessionId` | Get session details |
| GET | `/api/sessions` | Get all sessions (demo purposes) |
| GET | `/api/sessions/:sessionId/result` | Get payment session status from Adyen |
| POST | `/api/payments/:pspReference/capture` | Capture an authorised payment |
| POST | `/api/payments/:pspReference/cancel` | Cancel an authorised (not yet captured) payment |
| POST | `/api/payments/:pspReference/refund` | Refund a captured payment |
| POST | `/api/webhooks` | Webhook endpoint for Adyen notifications (HMAC-verified, deduplicated) |
| GET | `/api/webhooks` | Get webhook log (demo purposes) |

### Example API Requests
#### Create Payment Session
```bash
curl -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 1000,
    "currency": "EUR",
    "countryCode": "NL",
    "reference": "ORDER_12345",
    "shopperEmail": "shopper@example.com",
    "shopperReference": "SHOPPER_123"
  }'
```
#### Capture a Payment
```bash
curl -X POST http://localhost:3001/api/payments/{pspReference}/capture \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "{sessionId}",
    "amount": { "value": 1000, "currency": "EUR" }
  }'
```
#### Cancel or Refund a Payment
```bash
curl -X POST http://localhost:3001/api/payments/{pspReference}/cancel \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "{sessionId}" }'

curl -X POST http://localhost:3001/api/payments/{pspReference}/refund \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "{sessionId}", "amount": { "value": 1000, "currency": "EUR" } }'
```
#### Get Session Result
```bash
curl "http://localhost:3001/api/sessions/{sessionId}/result?sessionResult={sessionResult}"
```

## 📊 Payment Flow Walkthrough
### 1. Session Creation
The backend creates a payment session by calling Adyen's `/sessions` endpoint, wrapped in an idempotent retry helper (see Reliability below):
```javascript
const createCheckoutSessionRequest = {
  merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
  amount: {
    value: 1000,  // 10.00 EUR in minor units
    currency: "EUR"
  },
  returnUrl: "http://localhost:8080/result",
  reference: "ORDER_12345",
  countryCode: "NL",
  channel: "Web"
};

const response = await callAdyenWithIdempotentRetry((idempotencyKey) =>
  checkoutAPI.PaymentsApi.sessions(createCheckoutSessionRequest, { idempotencyKey })
);
```
**Response includes:**
- `sessionData`: Encoded session data for frontend
- `id`: Unique session identifier
- `expiresAt`: Session expiration time

### 2. Frontend Initialization
The frontend imports Adyen Web directly from the installed npm package and initializes Checkout with the session:
```javascript
import { AdyenCheckout, Dropin } from '/node_modules/@adyen/adyen-web/auto/auto.js';

const configuration = {
  session: {
    id: sessionData.id,
    sessionData: sessionData.sessionData
  },
  environment: 'test',
  clientKey: 'your_client_key',
  onPaymentCompleted: (result) => handlePaymentResult(result),
  onPaymentFailed: (result) => handlePaymentResult(result)
};

const checkout = await AdyenCheckout(configuration);
new Dropin(checkout, {}).mount('#dropin-container');
```

### 3. Payment Processing
The shopper completes payment through the Drop-in component:
- Selects payment method
- Enters payment details
- Handles 3D Secure authentication if required
- Submits payment

### 4. Webhook Handling
Adyen sends an `AUTHORISATION` webhook to the backend. Every incoming webhook is verified against its HMAC signature and checked for duplicate delivery before any business logic runs:
```json
{
  "notificationItems": [{
    "NotificationRequestItem": {
      "eventCode": "AUTHORISATION",
      "merchantReference": "ORDER_12345",
      "success": "true",
      "pspReference": "PSP_REFERENCE",
      "amount": { "value": 1000, "currency": "EUR" },
      "additionalData": { "hmacSignature": "..." }
    }
  }]
}
```
The same webhook endpoint also handles `CAPTURE`, `CANCELLATION`, and `REFUND` events, generated by the corresponding modification endpoints below.

### 5. Post-Authorization: Capture, Cancel, Refund
Once a payment is authorised, three actions are available (mutually exclusive by state — a captured payment can no longer be cancelled, only refunded):
- **Capture** — settles the authorised amount
- **Cancel** — voids an authorised, not-yet-captured payment
- **Refund** — reverses a captured payment

Each of these returns `status: "received"` immediately, which only confirms Adyen *accepted* the request — the actual outcome always arrives later via webhook (`CAPTURE`, `CANCELLATION`, or `REFUND` respectively).

### 6. Result Verification
The payment result can be verified through:
- **Frontend callback**: Immediate `onPaymentCompleted` or `onPaymentFailed` (provisional — resultCode only)
- **Webhook processing**: Asynchronous notification to backend (authoritative — includes PSP reference)
- **API query**: `/sessions/{id}?sessionResult={sessionResult}` endpoint (status only, on this API version)

## 🛡️ Reliability
Beyond the happy path, this demo implements the reliability practices a production integration actually needs:

### Idempotency
Every mutating Adyen call (session creation, capture, cancel, refund) is wrapped in a retry helper that:
- Generates a real UUIDv4 idempotency key once per logical request (not per retry attempt — reusing the same key across retries is what makes idempotency actually work)
- Retries only on Adyen's documented transient conditions: a `transient-error: true` response header, or error code `704` ("request already processed or in progress")
- Uses exponential backoff (1s, 2s, 4s) between attempts

### Webhook Deduplication
Adyen uses at-least-once delivery — the same webhook can legitimately arrive more than once. Duplicates are detected using the exact key Adyen's own docs specify: the combination of `eventCode` and `pspReference`. A duplicate is acknowledged with `200 OK` but never reprocessed.

### HMAC Signature Verification
Every incoming webhook is verified using `@adyen/api-library`'s `hmacValidator` before any business logic runs. Without `ADYEN_HMAC_KEY` configured, the backend fails closed — it logs a startup warning and rejects all webhooks rather than silently trusting unverified payloads.

## 🌍 Currency Support
The currency selector includes all 138 currencies Adyen supports, sourced directly from [Adyen's currency codes documentation](https://docs.adyen.com/development-resources/currency-codes). Amount conversion to Adyen's minor-unit format is currency-aware — most currencies use 2 decimals, but the app correctly handles:
- **0-decimal currencies**: JPY, KRW, VND, and others
- **3-decimal currencies**: BHD, KWD, OMR, and others

A naive `amount * 100` breaks for roughly 15% of Adyen's supported currencies — this demo handles that explicitly rather than assuming the common case.

## 🔍 API Behavior Validation

### Monitoring API Responses
The demo provides several ways to inspect API behavior:

#### 1. Backend Console Logs
All API calls, retries, and webhook processing are logged to the console:
```bash
# Backend terminal shows:
Creating session with params: { amount: 1000, currency: 'EUR', ... }
Session created successfully: CSD9CAC34EBAE225DD
Webhook received: { notificationItems: [...] }
HMAC verified. Processing webhook: AUTHORISATION for ORDER_12345
Requesting capture for payment PSP_REFERENCE: {...}
Duplicate webhook ignored: AUTHORISATION for pspReference PSP_REFERENCE (first processed at ...)
```

#### 2. Session Tracking API
```bash
# Get all sessions
curl http://localhost:3001/api/sessions
# Get specific session
curl http://localhost:3001/api/sessions/CSD9CAC34EBAE225DD
```

#### 3. Webhook Log API
```bash
# Get all webhook notifications
curl http://localhost:3001/api/webhooks
```

### Payment Status Changes
The demo tracks payment status through these stages:
1. **Created**: Session created, awaiting payment
2. **Processing**: Payment submitted to Adyen
3. **Authorised**: Payment successfully authorized
4. **Failed**: Payment refused or errored
5. **Cancelled**: Payment cancelled before capture
6. **Captured / Refunded**: Post-authorization modifications, each confirmed via their own webhook event

Status updates occur through:
- Immediate frontend callbacks (provisional)
- Webhook notifications (authoritative, within seconds — occasionally longer over ngrok in testing)
- API query results

## 🧪 Testing with Real Payments

### Test Card Numbers
Use these test card numbers to simulate different payment scenarios:

| Card Number | Brand | Result |
|-------------|-------|--------|
| 4111 1111 1111 1111 | Visa | Authorised |
| 5425 2345 6789 0123 | Mastercard | Authorised |
| 4222 2222 2222 2222 | Visa | Refused |
| 3782 822463 10005 | American Express | Authorised |

### Testing 3D Secure
To test 3D Secure authentication:
1. Use card: 4012 0000 0000 0088
2. Use any future expiry date
3. Use any 3-digit CVC
4. Enter any 3D Secure password when prompted

### Testing Webhooks
Since the demo runs on localhost, webhooks won't be automatically received. To test webhooks:
1. Use a tunneling service like ngrok:
```bash
ngrok http 3001
```
2. Register the ngrok URL (`https://your-url.ngrok-free.app/api/webhooks`) as a Standard webhook in your Adyen test Customer Area, and generate an HMAC key for it
3. Copy that HMAC key into `ADYEN_HMAC_KEY` in `.env`
4. Test a payment and observe webhook logs in the backend console — note that free-tier ngrok URLs change on every restart and need re-registering each time

## 📁 Project Structure
```
test2/
├── backend/
│   ├── server.js              # Express server: sessions, capture/cancel/refund, webhook handling
│   ├── package.json           # Backend dependencies
│   ├── .env.example          # Environment variables template
│   └── .env                  # Your actual configuration (gitignored)
├── frontend/
│   ├── index.html            # Frontend with Adyen Drop-in (npm-imported, no CDN)
│   ├── node_modules/         # Includes @adyen/adyen-web
│   └── package.json          # Frontend dependencies
├── logs/                     # Server logs directory
└── README.md                 # This file
```

## 🔐 Security Considerations
This demo uses test credentials and is for educational purposes. What's already implemented, and what would still need attention for production:

**Implemented:**
1. ✅ **Webhook signature verification** — every incoming webhook is HMAC-verified before processing; unverified/invalid webhooks are rejected, not silently trusted
2. ✅ **API key never exposed to the frontend** — only the public client key and single-use session data reach the browser
3. ✅ **Environment variables** used for all sensitive configuration (`.env`, gitignored)

**Still needed for production:**
1. **Never commit API keys** to version control (this demo's `.env` is gitignored, but double-check before any repo goes public)
2. **Use HTTPS** for all API communications (ngrok provides this for local testing; a real deployment needs its own TLS termination)
3. **Persistent storage** — session and webhook state currently live in an in-memory `Map`, which doesn't survive a restart or scale across multiple server instances
4. **Transport-level webhook authentication** (Basic Auth/OAuth) as defense-in-depth alongside HMAC verification, which is currently the only layer in place

## 🛠️ Troubleshooting

### Common Issues

#### 1. "Failed to create session"
- Verify your Adyen API key is correct
- Check that your merchant account is active
- Ensure the API key has the required permissions

#### 2. "Failed to initialize payment form"
- Verify your client key is correct
- Check the browser console for the actual import error — confirm `@adyen/adyen-web` is installed in `frontend/node_modules`, not just `backend/node_modules`
- Ensure CORS is properly configured

#### 3. Webhook not received, or rejected
- Check if your server is publicly accessible (ngrok running, URL registered in the Customer Area)
- If webhooks arrive but get rejected, check the backend logs for `HMAC signature verification failed` — this usually means `ADYEN_HMAC_KEY` doesn't match what's configured in the Customer Area, or the backend wasn't restarted after changing `.env` (nodemon does not watch `.env` by default — restart manually)
- Verify webhook URL is correctly configured in Adyen Customer Area

#### 4. Payment status not updating
- Check backend console logs for `HMAC verified. Processing webhook: ...` — if you see `Duplicate webhook ignored` instead, that's expected behavior for a redelivered webhook, not a bug
- Verify session ID matches between frontend and backend
- For capture/cancel/refund specifically, webhooks can take anywhere from a few seconds up to roughly a minute over ngrok — the UI polls for up to 60 seconds before offering a manual "check status" retry

## 📚 Additional Resources
- [Adyen Sessions Flow Documentation](https://docs.adyen.com/online-payments/build-your-integration/sessions-flow?platform=Web&integration=Drop-in&version=6.41.1)
- [Adyen API Explorer](https://docs.adyen.com/api-explorer)
- [Adyen Test Cards](https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers)
- [Adyen Currency Codes](https://docs.adyen.com/development-resources/currency-codes)
- [Verify HMAC Signatures](https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures)
- [API Idempotency](https://docs.adyen.com/development-resources/api-idempotency)

## 🎓 Learning Objectives
This demo demonstrates:
- ✅ How to structure a payment integration with separate frontend/backend
- ✅ How to create and manage payment sessions
- ✅ How to implement Adyen Web Drop-in via npm (no CDN, no bundler)
- ✅ How to handle payment results through multiple channels
- ✅ How to process, verify, and deduplicate webhooks
- ✅ How to implement capture, cancel, and refund with correct async webhook handling
- ✅ How to implement idempotent retries per Adyen's documented conventions
- ✅ How to handle Adyen's full currency list correctly, including non-2-decimal currencies
- ✅ How to track payment status changes
- ✅ How to debug and monitor API interactions

## 🚀 Next Steps
Deliberately out of scope for this demo, worth naming explicitly:
1. Add database persistence for payment and webhook records (currently in-memory)
2. Add transport-level webhook authentication (Basic Auth/OAuth) alongside HMAC verification
3. Add distinct UI handling for the `Pending` payment state (currently handled generically alongside other non-authorised outcomes)
4. Add support for additional payment methods beyond what Drop-in shows by default
5. Add proper structured logging and monitoring
6. Deploy to a production environment with real TLS and horizontal scaling

## 📝 License
This demo is for educational purposes. Ensure you comply with Adyen's terms of service when implementing payments in production.

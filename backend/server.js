require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // built into Node — used for real UUIDv4 idempotency keys
const { Client, CheckoutAPI, hmacValidator } = require('@adyen/api-library');
const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:8080`;
// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Adyen client setup
const client = new Client({
  apiKey: process.env.ADYEN_API_KEY,
  environment: process.env.ADYEN_ENVIRONMENT || 'test',
  hmacKey: process.env.ADYEN_HMAC_KEY || undefined
});
const checkoutAPI = new CheckoutAPI(client);

// HMAC verification for incoming webhooks (see https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures).
// Every notification's additionalData.hmacSignature is checked against this
// key before we trust anything in the payload. Without a real key, we can't
// distinguish a genuine Adyen webhook from a forged POST to this endpoint.
const validator = new hmacValidator();
if (!process.env.ADYEN_HMAC_KEY) {
  console.warn(
    '⚠️  ADYEN_HMAC_KEY is not set. Incoming webhooks will be REJECTED until you ' +
    'generate an HMAC key for your webhook in the Adyen Customer Area and set it ' +
    'in your .env file. This fails closed (safe) rather than skipping verification.'
  );
}

// ---------------------------------------------------------------------------
// Idempotency (see https://docs.adyen.com/development-resources/api-idempotency)
//
// Adyen's idempotency guarantee only holds if the SAME key is reused across
// retries of the SAME logical request. Generating a fresh key per retry
// attempt (e.g. from Date.now()) defeats the purpose entirely — it just
// causes Adyen to process each "retry" as a brand new, unrelated request.
//
// generateIdempotencyKey() — a real UUIDv4, generated once per logical
// request, as Adyen's docs recommend ("Generate unique idempotency keys per
// request using the version 4 (random) UUID type").
//
// isTransientAdyenError() — per the docs, only retry when the response
// carries a `transient-error: true` header, or when the API returns the
// specific "already processed or in progress" race-condition error
// (errorCode 704, HTTP 409/422) — both are explicitly called out as safe to
// retry with the same key. Anything else (validation errors, auth failures,
// etc.) must NOT be retried, since retrying a non-transient error can't
// succeed and just wastes time / hides the real problem.
//
// callAdyenWithIdempotentRetry() — generates one key, calls requestFn with
// it, and on a transient failure retries with exponential backoff — always
// reusing that same key so Adyen can deduplicate correctly.
// ---------------------------------------------------------------------------

function generateIdempotencyKey() {
  return crypto.randomUUID();
}

function isTransientAdyenError(error) {
  const transientHeader = error?.responseHeaders?.['transient-error'];
  if (transientHeader === 'true') return true;

  // errorCode 704 = "request already processed or in progress" — a race
  // condition the docs explicitly describe as safe to retry.
  if (error?.errorCode === '704') return true;

  return false;
}

async function callAdyenWithIdempotentRetry(requestFn, { maxRetries = 3, baseDelayMs = 1000 } = {}) {
  const idempotencyKey = generateIdempotencyKey();
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retrying with idempotency key ${idempotencyKey} (attempt ${attempt + 1}/${maxRetries + 1})`);
      }
      return await requestFn(idempotencyKey);
    } catch (error) {
      lastError = error;

      if (!isTransientAdyenError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s, ...
      console.warn(
        `Transient error on idempotency key ${idempotencyKey} ` +
        `(errorCode: ${error?.errorCode}, transient-error header: ${error?.responseHeaders?.['transient-error']}). ` +
        `Retrying in ${delayMs}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// Store for demo purposes (in production, use a real database)
const paymentStore = new Map(); // keyed by session id
const pspReferenceIndex = new Map(); // maps a payment pspReference -> session id, so CAPTURE/CANCELLATION webhooks (which only carry originalReference) can be matched back to a session

// Webhook deduplication (see https://docs.adyen.com/development-resources/webhooks/handle-webhook-events):
// "duplicate webhook events have the same values in the eventCode and
// pspReference fields, while the eventDate and other fields can be
// different." Adyen uses at-least-once delivery — the same event can
// legitimately arrive more than once (e.g. if our 200 response was slow or
// lost in transit), and reprocessing it must not re-run business logic a
// second time. Demo-scale: an in-memory Map, unbounded — a real deployment
// would use a DB table with a unique constraint on (eventCode, pspReference)
// and a retention/TTL policy instead.
const processedWebhookEvents = new Map(); // key: `${eventCode}:${pspReference}` -> first-seen timestamp
const webhookLog = [];
// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Config endpoint (for frontend to get client key)
app.get('/api/config', (req, res) => {
  res.json({
    clientKey: process.env.ADYEN_CLIENT_KEY || 'test_client_key_placeholder',
    environment: process.env.ADYEN_ENVIRONMENT || 'test',
    merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT
  });
});
// Create session endpoint
app.post('/api/sessions', async (req, res) => {
  try {
    const { amount, currency, countryCode, reference, shopperEmail, shopperReference, preAuth } = req.body;
    console.log('Creating session with params:', {
      amount,
      currency,
      countryCode,
      reference,
      shopperEmail,
      shopperReference,
      preAuth
    });
    const createCheckoutSessionRequest = {
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      amount: {
        value: amount || 1000, // Default 10.00 EUR
        currency: currency || 'EUR'
      },
      returnUrl: `${FRONTEND_URL}/result`,
      reference: reference || `ORDER_${Date.now()}`,
      countryCode: countryCode || 'NL',
      channel: 'Web',
      shopperEmail: shopperEmail,
      shopperReference: shopperReference,
      // Opt-in only — default behaviour (FinalAuth, immediate settlement) is
      // unchanged unless the caller explicitly requests PreAuth. PreAuth
      // requires manualCapture, which is exactly what our existing
      // Capture/Cancel/Refund flow already assumes.
      // See https://docs.adyen.com/api-explorer/Checkout/latest/post/sessions#request-additionalData-AdditionalDataCommon-authorisationType
      ...(preAuth ? {
        additionalData: {
          authorisationType: 'PreAuth',
          manualCapture: 'true'
        }
      } : {})
    };
    const response = await callAdyenWithIdempotentRetry((idempotencyKey) =>
      checkoutAPI.PaymentsApi.sessions(createCheckoutSessionRequest, { idempotencyKey })
    );
    // Store session info for demo tracking
    paymentStore.set(response.id, {
      ...response,
      createdAt: new Date().toISOString(),
      status: 'created'
    });
    console.log('Session created successfully:', response.id);
    res.json(response);
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({
      error: 'Failed to create session',
      message: error.message,
      details: error.response?.data || error.stack
    });
  }
});
// Get session status endpoint (for demo purposes)
app.get('/api/sessions/:sessionId', (req, res) => {
  const session = paymentStore.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});
// Get all sessions (for demo purposes)
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(paymentStore.values());
  res.json(sessions);
});
// Capture an authorised payment
// POST /payments/{paymentPspReference}/captures
app.post('/api/payments/:pspReference/capture', async (req, res) => {
  try {
    const { pspReference } = req.params;
    const { sessionId } = req.body;
    let { amount } = req.body;

    // If the caller didn't supply an amount, fall back to the amount stored
    // when the session was created — this covers the case where the shopper
    // returned from a redirect and the client no longer has that state.
    if (!amount && sessionId) {
      const session = paymentStore.get(sessionId);
      amount = session?.amount;
    }

    if (!amount || amount.value == null || !amount.currency) {
      return res.status(400).json({
        error: 'Could not determine capture amount. Provide amount (value, currency) in the request body, or a valid sessionId.'
      });
    }

    const captureRequest = {
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      amount: {
        value: amount.value,
        currency: amount.currency
      },
      reference: `CAPTURE_${Date.now()}`
    };

    console.log(`Requesting capture for payment ${pspReference}:`, captureRequest);

    const response = await callAdyenWithIdempotentRetry((idempotencyKey) =>
      checkoutAPI.ModificationsApi.captureAuthorisedPayment(pspReference, captureRequest, { idempotencyKey })
    );

    console.log('Capture request accepted by Adyen:', response);

    // Index this payment's pspReference against the session, so the
    // asynchronous CAPTURE webhook (which only carries originalReference)
    // can be matched back to the right session.
    if (sessionId) {
      pspReferenceIndex.set(pspReference, sessionId);
      const session = paymentStore.get(sessionId);
      if (session) {
        session.captureRequest = response;
        session.captureStatus = 'pending'; // outcome arrives via CAPTURE webhook
        paymentStore.set(sessionId, session);
      }
    }

    // response.status is always "received" here — this only confirms Adyen
    // accepted the request, not that the capture succeeded. The real result
    // comes via the CAPTURE webhook.
    res.json(response);
  } catch (error) {
    console.error('Error requesting capture:', error);
    res.status(error.statusCode || 500).json({
      error: 'Failed to request capture',
      message: error.message,
      details: error.response?.data || error.stack
    });
  }
});
// Cancel an authorised (not yet captured) payment
// POST /payments/{paymentPspReference}/cancels
app.post('/api/payments/:pspReference/cancel', async (req, res) => {
  try {
    const { pspReference } = req.params;
    const { sessionId } = req.body;

    const cancelRequest = {
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      reference: `CANCEL_${Date.now()}`
    };

    console.log(`Requesting cancellation for payment ${pspReference}:`, cancelRequest);

    const response = await callAdyenWithIdempotentRetry((idempotencyKey) =>
      checkoutAPI.ModificationsApi.cancelAuthorisedPaymentByPspReference(pspReference, cancelRequest, { idempotencyKey })
    );

    console.log('Cancel request accepted by Adyen:', response);

    if (sessionId) {
      pspReferenceIndex.set(pspReference, sessionId);
      const session = paymentStore.get(sessionId);
      if (session) {
        session.cancelRequest = response;
        session.cancelStatus = 'pending'; // outcome arrives via CANCELLATION webhook
        paymentStore.set(sessionId, session);
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Error requesting cancellation:', error);
    res.status(error.statusCode || 500).json({
      error: 'Failed to request cancellation',
      message: error.message,
      details: error.response?.data || error.stack
    });
  }
});
// Refund a captured payment
// POST /payments/{paymentPspReference}/refunds
app.post('/api/payments/:pspReference/refund', async (req, res) => {
  try {
    const { pspReference } = req.params;
    const { sessionId } = req.body;
    let { amount } = req.body;

    // Same fallback as capture: if no amount was supplied, use the amount
    // stored when the session was created (covers the redirect-flow case
    // where the client no longer has that state).
    if (!amount && sessionId) {
      const session = paymentStore.get(sessionId);
      amount = session?.amount;
    }

    if (!amount || amount.value == null || !amount.currency) {
      return res.status(400).json({
        error: 'Could not determine refund amount. Provide amount (value, currency) in the request body, or a valid sessionId.'
      });
    }

    const refundRequest = {
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      amount: {
        value: amount.value,
        currency: amount.currency
      },
      reference: `REFUND_${Date.now()}`
    };

    console.log(`Requesting refund for payment ${pspReference}:`, refundRequest);

    const response = await callAdyenWithIdempotentRetry((idempotencyKey) =>
      checkoutAPI.ModificationsApi.refundCapturedPayment(pspReference, refundRequest, { idempotencyKey })
    );

    console.log('Refund request accepted by Adyen:', response);

    if (sessionId) {
      pspReferenceIndex.set(pspReference, sessionId);
      const session = paymentStore.get(sessionId);
      if (session) {
        session.refundRequest = response;
        session.refundStatus = 'pending'; // outcome arrives via REFUND webhook
        paymentStore.set(sessionId, session);
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Error requesting refund:', error);
    res.status(error.statusCode || 500).json({
      error: 'Failed to request refund',
      message: error.message,
      details: error.response?.data || error.stack
    });
  }
});
// Webhook endpoint
app.post('/api/webhooks', (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    const webhookData = {
      receivedAt: new Date().toISOString(),
      data: req.body
    };
    webhookLog.push(webhookData);
    // Process webhook notifications
    if (req.body.notificationItems) {
      req.body.notificationItems.forEach(notification => {
        const item = notification.NotificationRequestItem;

        // Verify HMAC signature before trusting anything in this item.
        // Without this, any POST to this endpoint (not just genuine ones
        // from Adyen) would be processed as if it were a real payment
        // outcome — capable of marking a session "authorised" that was
        // never actually paid.
        if (!process.env.ADYEN_HMAC_KEY) {
          console.error(
            `Rejecting webhook for ${item.merchantReference}: ADYEN_HMAC_KEY is not configured. ` +
            'Generate one in the Customer Area and set it in .env.'
          );
          return; // skip this item — do not process it
        }

        let hmacIsValid = false;
        try {
          hmacIsValid = validator.validateHMAC(item, process.env.ADYEN_HMAC_KEY);
        } catch (hmacError) {
          // validateHMAC throws if additionalData.hmacSignature is missing
          // entirely, e.g. a malformed or forged request.
          console.error(`HMAC validation error for ${item.merchantReference}:`, hmacError.message);
        }

        if (!hmacIsValid) {
          console.error(
            `Rejecting webhook for ${item.merchantReference}: HMAC signature verification failed. ` +
            'This notification was not accepted as genuinely originating from Adyen.'
          );
          return; // skip this item — do not process it
        }

        // Deduplicate AFTER verifying authenticity (a forged duplicate still
        // gets rejected above by HMAC, regardless of this check) but BEFORE
        // any business logic runs, so a legitimate redelivery can never
        // update paymentStore / pspReferenceIndex a second time.
        const dedupKey = `${item.eventCode}:${item.pspReference}`;
        if (processedWebhookEvents.has(dedupKey)) {
          console.log(
            `Duplicate webhook ignored: ${item.eventCode} for pspReference ${item.pspReference} ` +
            `(first processed at ${processedWebhookEvents.get(dedupKey)}). Re-acknowledging without reprocessing.`
          );
          return; // still counts as "received" from Adyen's perspective — see the 200 response below
        }
        processedWebhookEvents.set(dedupKey, new Date().toISOString());

        console.log(`HMAC verified. Processing webhook: ${item.eventCode} for ${item.merchantReference}`);

        if (item.eventCode === 'AUTHORISATION') {
          // Original authorisation outcome. Keyed by checkoutSessionId.
          const sessionId = item.additionalData?.checkoutSessionId;
          const session = sessionId && paymentStore.get(sessionId);

          if (session) {
            session.status = item.success === 'true' ? 'authorised' : 'failed';
            session.webhookData = item;
            session.updatedAt = new Date().toISOString();
            paymentStore.set(sessionId, session);

            // Index the payment's pspReference -> session, so later
            // CAPTURE/CANCELLATION webhooks (which reference this
            // pspReference as their originalReference) can find their way
            // back to this session.
            if (item.pspReference) {
              pspReferenceIndex.set(item.pspReference, sessionId);
            }

            console.log(`Updated session ${sessionId} status to ${session.status}`);
          }
        } else if (item.eventCode === 'CAPTURE' || item.eventCode === 'CANCELLATION' || item.eventCode === 'REFUND') {
          // Modification outcome. Keyed by originalReference, which is the
          // pspReference of the original authorised payment.
          const sessionId = pspReferenceIndex.get(item.originalReference);
          const session = sessionId && paymentStore.get(sessionId);

          if (session) {
            const fieldsByEventCode = {
              CAPTURE: { statusField: 'captureStatus', webhookField: 'captureWebhook' },
              CANCELLATION: { statusField: 'cancelStatus', webhookField: 'cancelWebhook' },
              REFUND: { statusField: 'refundStatus', webhookField: 'refundWebhook' }
            };
            const { statusField, webhookField } = fieldsByEventCode[item.eventCode];

            session[statusField] = item.success === 'true' ? 'success' : 'failed';
            session[webhookField] = item;
            session.updatedAt = new Date().toISOString();
            paymentStore.set(sessionId, session);

            console.log(`Updated session ${sessionId} ${statusField} to ${session[statusField]}`);
          } else {
            console.warn(`Received ${item.eventCode} webhook for unknown originalReference: ${item.originalReference}`);
          }
        }
      });
    }
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({
      error: 'Failed to process webhook',
      message: error.message
    });
  }
});
// Get webhook log (for demo purposes)
app.get('/api/webhooks', (req, res) => {
  res.json(webhookLog);
});
// Get payment result from Adyen API
app.get('/api/sessions/:sessionId/result', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { sessionResult } = req.query;
    if (!sessionResult) {
      return res.status(400).json({ error: 'sessionResult query parameter is required' });
    }
    const response = await checkoutAPI.PaymentsApi.getResultOfPaymentSession(
      sessionId,
      sessionResult
    );
    // Update our local store
    const session = paymentStore.get(sessionId);
    if (session) {
      session.sessionResult = response;
      session.status = response.status;
      paymentStore.set(sessionId, session);
    }
    res.json(response);
  } catch (error) {
    console.error('Error getting session result:', error);
    res.status(500).json({
      error: 'Failed to get session result',
      message: error.message
    });
  }
});
// Serve static files from frontend
app.use(express.static('../frontend'));
// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});
// Start server
const server = app.listen(PORT, () => {
  console.log(`Adyen Sessions Backend running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Health check: ${BASE_URL}/health`);
  console.log(`Create session: ${BASE_URL}/api/sessions`);
  console.log(`Webhook endpoint: ${BASE_URL}/api/webhooks`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the process using it or choose a different port.`);
    process.exit(1);
  } else {
    throw err;
  }
});
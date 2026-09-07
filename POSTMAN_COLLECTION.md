# Postman Collection for Adyen Sessions Demo

This document provides example API requests for testing the Adyen Sessions flow integration using Postman or similar tools.

## Base URL
```
http://localhost:3000
```

## API Endpoints

### 1. Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. Get Configuration
```http
GET /api/config
```

**Response:**
```json
{
  "clientKey": "test_client_key_placeholder",
  "environment": "test",
  "merchantAccount": "YourMerchantAccount"
}
```

### 3. Create Payment Session
```http
POST /api/sessions
Content-Type: application/json
```

**Request Body:**
```json
{
  "amount": 1000,
  "currency": "EUR",
  "countryCode": "NL",
  "reference": "ORDER_12345",
  "shopperEmail": "shopper@example.com",
  "shopperReference": "SHOPPER_123"
}
```

**Response:**
```json
{
  "amount": {
    "currency": "EUR",
    "value": 1000
  },
  "countryCode": "NL",
  "expiresAt": "2024-01-15T11:30:00+01:00",
  "id": "CSD9CAC34EBAE225DD",
  "merchantAccount": "YourMerchantAccount",
  "reference": "ORDER_12345",
  "returnUrl": "http://localhost:8080/result",
  "sessionData": "Ab02b4c..."
}
```

### 4. Get Session Details
```http
GET /api/sessions/:sessionId
```

**Example:**
```http
GET /api/sessions/CSD9CAC34EBAE225DD
```

**Response:**
```json
{
  "id": "CSD9CAC34EBAE225DD",
  "amount": {
    "currency": "EUR",
    "value": 1000
  },
  "status": "created",
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### 5. Get All Sessions
```http
GET /api/sessions
```

**Response:**
```json
[
  {
    "id": "CSD9CAC34EBAE225DD",
    "status": "created",
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  {
    "id": "CSD9CAC34EBAE225DE",
    "status": "authorised",
    "createdAt": "2024-01-15T10:25:00.000Z"
  }
]
```

### 6. Get Payment Result
```http
GET /api/sessions/:sessionId/result?sessionResult=:sessionResult
```

**Example:**
```http
GET /api/sessions/CSD9CAC34EBAE225DD/result?sessionResult=X6XtfGC3!Y...
```

**Response:**
```json
{
  "id": "CSD9CAC34EBAE225DD",
  "status": "completed",
  "payments": [
    {
      "amount": {
        "currency": "EUR",
        "value": 1000
      },
      "paymentMethod": {
        "brand": "visa",
        "type": "scheme"
      },
      "pspReference": "TG9SNBJJNXRKDM92",
      "resultCode": "Authorised"
    }
  ],
  "reference": "ORDER_12345"
}
```

### 7. Send Webhook (Simulated)
```http
POST /api/webhooks
Content-Type: application/json
```

**Request Body (Successful Payment):**
```json
{
  "live": "false",
  "notificationItems": [
    {
      "NotificationRequestItem": {
        "eventCode": "AUTHORISATION",
        "merchantAccountCode": "YourMerchantAccount",
        "reason": "033899:1111:03/2030",
        "amount": {
          "currency": "EUR",
          "value": 1000
        },
        "operations": ["CANCEL", "CAPTURE", "REFUND"],
        "success": "true",
        "paymentMethod": "mc",
        "additionalData": {
          "expiryDate": "03/2030",
          "authCode": "033899",
          "cardBin": "411111",
          "cardSummary": "1111",
          "checkoutSessionId": "CSD9CAC34EBAE225DD"
        },
        "merchantReference": "ORDER_12345",
        "pspReference": "NC6HT9CRT65ZGN82",
        "eventDate": "2024-01-15T10:30:00+01:00"
      }
    }
  ]
}
```

**Request Body (Failed Payment):**
```json
{
  "live": "false",
  "notificationItems": [
    {
      "NotificationRequestItem": {
        "eventCode": "AUTHORISATION",
        "merchantAccountCode": "YourMerchantAccount",
        "reason": "validation 101 Invalid card number",
        "amount": {
          "currency": "EUR",
          "value": 1000
        },
        "success": "false",
        "paymentMethod": "unknowncard",
        "additionalData": {
          "expiryDate": "03/2030",
          "cardBin": "411111",
          "cardSummary": "1112",
          "checkoutSessionId": "CSD9CAC34EBAE225DD"
        },
        "merchantReference": "ORDER_12345",
        "pspReference": "KHQC5N7G84BLNK43",
        "eventDate": "2024-01-15T10:30:00+01:00"
      }
    }
  ]
}
```

**Response:**
```json
{
  "received": true
}
```

### 8. Get Webhook Log
```http
GET /api/webhooks
```

**Response:**
```json
[
  {
    "receivedAt": "2024-01-15T10:30:00.000Z",
    "data": {
      "live": "false",
      "notificationItems": [...]
    }
  }
]
```

## Testing Workflow

### Complete Payment Flow Test

1. **Create Session**
   ```bash
   POST /api/sessions
   ```
   Save the `id` and `sessionData` from the response.

2. **Initialize Frontend**
   - Open http://localhost:8080
   - The frontend will automatically create a session
   - Complete payment using test card details

3. **Check Session Status**
   ```bash
   GET /api/sessions/{sessionId}
   ```

4. **Simulate Webhook** (for testing without real payment)
   ```bash
   POST /api/webhooks
   ```
   Use the simulated webhook body from above.

5. **Verify Final Status**
   ```bash
   GET /api/sessions/{sessionId}
   ```

## Testing Different Scenarios

### Successful Payment
- Use card: 4111 1111 1111 1111
- Expected result: Authorised

### Failed Payment
- Use card: 4222 2222 2222 2222
- Expected result: Refused

### 3D Secure Payment
- Use card: 4012 0000 0000 0088
- Expected result: Authorised (with 3D Secure)

### Amount Variations
```json
{
  "amount": 5000,    // 50.00
  "currency": "USD"
}
```

### Different Countries
```json
{
  "countryCode": "US",
  "currency": "USD"
}
```

## Importing into Postman

1. Copy the above requests
2. Create a new Postman collection
3. Set base URL: `http://localhost:3000`
4. Add each request with the appropriate method and body
5. Save for quick testing

## Environment Variables

Create environment variables in Postman:
```
@baseUrl = http://localhost:3000
@sessionId = {{createSession.response.id}}
@sessionResult = {{createSession.response.sessionData}}
```

Use variables in requests:
```
GET {{baseUrl}}/api/sessions/{{sessionId}}
```
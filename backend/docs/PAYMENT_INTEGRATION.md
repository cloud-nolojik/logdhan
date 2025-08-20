# Cashfree Payment Integration

This document describes the Cashfree payment integration for the Logdhan backend.

## Overview

The payment system allows users to recharge their credits using Cashfree's payment gateway. The integration follows a secure flow where:

1. Backend creates payment order with Cashfree
2. User completes payment on Cashfree's page
3. Cashfree sends webhook with payment status
4. Backend adds credits to user account on successful payment

## Architecture

### Components

- **Payment Model** (`src/models/payment.js`): Tracks payment orders and their status
- **Cashfree Service** (`src/services/payment/cashfree.service.js`): Handles Cashfree API interactions
- **Payment Routes** (`src/routes/payments.js`): API endpoints for payment operations
- **Credit Service** (`src/services/credit/credit.service.js`): Manages user credits

### Payment Flow

```
1. Android App → Backend (Create Order)
   POST /api/v1/payments/create-order
   {
     "amount": 500,
     "packageType": "premium"
   }

2. Backend → Cashfree API (Create Order)
   POST /orders
   Returns: payment_session_id

3. Backend → Android App (Order Details)
   {
     "orderId": "order_123",
     "paymentSessionId": "session_abc",
     "paymentUrl": "https://sandbox.cashfree.com/pg/view/..."
   }

4. Android App → Cashfree Payment Page
   Redirects user to payment page

5. User → Cashfree (Complete Payment)
   User enters payment details and completes payment

6. Cashfree → Backend (Webhook)
   POST /api/v1/payments/webhook
   {
     "order_id": "order_123",
     "payment_status": "SUCCESS",
     "payment_method": "UPI"
   }

7. Backend → Database (Add Credits)
   Updates payment status and adds credits to user
```

## API Endpoints

### Create Payment Order

**POST** `/api/v1/payments/create-order`

Creates a new payment order with Cashfree.

**Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "amount": 500,
  "packageType": "premium"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment order created successfully",
  "data": {
    "orderId": "order_1234567890",
    "paymentSessionId": "session_abc123",
    "amount": 500,
    "credits": 550,
    "paymentUrl": "https://sandbox.cashfree.com/pg/view/session_abc123",
    "returnUrl": "http://localhost:3000/payment/success?order_id=order_1234567890"
  }
}
```

### Get Payment Status

**GET** `/api/v1/payments/status/:orderId`

Get the status of a payment order.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "orderId": "order_1234567890",
    "amount": 500,
    "credits": 550,
    "status": "SUCCESS",
    "paymentMethod": "UPI",
    "createdAt": "2024-01-15T10:30:00Z",
    "completedAt": "2024-01-15T10:32:00Z",
    "cashfreeStatus": {
      "order_id": "order_1234567890",
      "order_status": "PAID",
      "payment_status": "SUCCESS"
    }
  }
}
```

### Get Payment History

**GET** `/api/v1/payments/history?page=1&limit=20`

Get user's payment history with pagination.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment_id",
        "orderId": "order_1234567890",
        "amount": 500,
        "credits": 550,
        "status": "SUCCESS",
        "paymentMethod": "UPI",
        "createdAt": "2024-01-15T10:30:00Z",
        "completedAt": "2024-01-15T10:32:00Z"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 5,
      "totalPayments": 100,
      "hasNext": true,
      "hasPrev": false
    }
  },
  "message": "Payment history retrieved successfully"
}
```

### Calculate Credits

**POST** `/api/v1/payments/calculate`

Calculate how many credits a user will get for a given amount.

**Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "amount": 500
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "amount": "₹500",
    "credits": 550,
    "rate": "₹1.00 per credit"
  },
  "message": "Credit calculation successful"
}
```

### Get Recharge Packages

**GET** `/api/v1/payments/packages`

Get available recharge packages.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "amount": 100,
      "credits": 100,
      "bonus": 0,
      "description": "₹100 = 100 Credits"
    },
    {
      "amount": 500,
      "credits": 550,
      "bonus": 50,
      "description": "₹500 = 550 Credits (50 Bonus)"
    }
  ],
  "message": "Recharge packages retrieved successfully"
}
```

## Webhook Handling

### Webhook Endpoint

**POST** `/api/v1/payments/webhook`

This endpoint receives payment status updates from Cashfree.

**Headers:**
```
x-webhook-signature: <signature>
Content-Type: application/json
```

**Request Body:**
```json
{
  "order_id": "order_1234567890",
  "payment_status": "SUCCESS",
  "payment_method": "UPI",
  "payment_amount": 500,
  "payment_message": "Payment successful"
}
```

### Webhook Processing

1. **Signature Verification**: Verifies webhook signature using HMAC SHA256
2. **Payment Lookup**: Finds payment record by order ID
3. **Status Update**: Updates payment status based on webhook data
4. **Credit Addition**: Adds credits to user account on successful payment
5. **Response**: Returns success response to Cashfree

## Environment Variables

Add these variables to your `.env` file:

```env
# Cashfree Configuration
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key

# Frontend and Backend URLs
FRONTEND_URL=your_frontend_url
BACKEND_URL=your_backend_url
```

## Security Features

### Webhook Signature Verification

All webhooks are verified using HMAC SHA256 signature to ensure they come from Cashfree:

```javascript
const expectedSignature = crypto
  .createHmac('sha256', secretKey)
  .update(payload)
  .digest('hex');
```

### User Authorization

All payment endpoints require JWT authentication to ensure users can only access their own payments.

### Database Transactions

Credit addition uses database transactions to ensure data consistency.

## Testing

### Run Integration Test

```bash
node scripts/test-cashfree.js
```

### Test Payment Flow

1. Create a test order with small amount
2. Complete payment on Cashfree sandbox
3. Verify webhook processing
4. Check credit addition

## Error Handling

### Common Errors

- **Invalid Amount**: Amount must be within configured limits
- **User Not Found**: User ID doesn't exist
- **Invalid Webhook Signature**: Webhook not from Cashfree
- **Payment Order Not Found**: Order ID doesn't exist
- **Insufficient Credits**: User doesn't have enough credits for service

### Error Responses

All endpoints return consistent error responses:

```json
{
  "success": false,
  "message": "Error description",
  "data": null
}
```

## Monitoring

### Payment Status Tracking

- All payments are tracked in the database
- Status updates are logged
- Failed payments are marked appropriately

### Webhook Monitoring

- Webhook processing is logged
- Failed webhooks are retried
- Invalid signatures are logged for security

## Production Checklist

- [ ] Configure production Cashfree credentials
- [ ] Set up webhook URL in Cashfree dashboard
- [ ] Test webhook signature verification
- [ ] Configure proper error handling
- [ ] Set up monitoring and logging
- [ ] Test complete payment flow
- [ ] Verify credit addition on successful payments 
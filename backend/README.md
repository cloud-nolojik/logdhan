# Logdhan Backend

Backend server for the Logdhan application, providing REST APIs for user authentication, stock watchlist management, trade logging, credit system, and notifications.

## Features

- **User Authentication**: OTP-based authentication with JWT tokens
- **Stock Management**: Search stocks, get stock details with TradingView integration
- **Watchlist Management**: Add/remove stocks from personal watchlist
- **Trade Logging**: Comprehensive trade entry system with buy/sell tracking
- **Credit System**: Credit-based AI services with recharge functionality
- **Notifications**: Real-time notifications for trade logs, AI reviews, and system alerts
- **Email Integration**: Postmark email service for notifications
- **Firebase Integration**: Push notifications and admin SDK
- **n8n Workflow Integration**: AI processing and automation

## Tech Stack

- **Runtime**: Node.js with ES modules
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Email**: Postmark
- **Push Notifications**: Firebase Admin SDK
- **Workflow Automation**: n8n
- **Code Quality**: ESLint, Prettier

## Prerequisites

- Node.js (v18+)
- MongoDB database
- n8n instance (for AI processing)
- Postmark account (for email notifications)
- Firebase project (for push notifications)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/logdhan-backend.git
cd logdhan-backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
# Server Configuration
PORT=5650
NODE_ENV=development

# MongoDB Configuration
MONGODB_URI=your_mongodb_connection_string

# JWT Configuration
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=7d

# API Configuration
API_PREFIX=/api/v1

# CORS Configuration
CORS_ORIGIN=http://localhost:5650

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# n8n Integration
N8N_WEBHOOK_BASE_URL=your_n8n_webhook_base_url
N8N_AI_REVIEW_WEBHOOK_ID=your_ai_review_webhook_id

# WhatsApp (for future use)
WHATSAPP_API_KEY=your_whatsapp_api_key

# Firebase Configuration
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY=your_firebase_private_key

# Email Configuration (Postmark)
POSTMARK_TOKEN=your_postmark_token
FROM_EMAIL=your_sender_email

# Cashfree Configuration
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key

# Frontend and Backend URLs
FRONTEND_URL=your_frontend_url
BACKEND_URL=your_backend_url
```

## Running the Server

Development mode with hot reload:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## API Documentation

### Authentication (`/api/v1/auth`)

- `POST /send-otp`: Send OTP to mobile number
- `POST /verify-otp`: Verify OTP and get JWT token
- `POST /login`: Login with email/password
- `GET /profile`: Get user profile
- `PUT /profile`: Update user profile

### Stock Management (`/api/v1/stocks`)

- `GET /search`: Search stocks by symbol or name
- `GET /:instrument_key`: Get detailed stock information with current price

### Watchlist (`/api/v1/watchlist`)

- `GET /`: Get user's watchlist
- `POST /`: Add stock to watchlist
- `DELETE /:symbol`: Remove stock from watchlist

### Trade Log (`/api/v1/stocklog`)

- `GET /`: Get user's trade logs with pagination
- `POST /`: Add new trade log entry
- `GET /export`: Export logs as CSV
- `GET /:id`: Get specific trade log details
- `PUT /:id`: Update trade log entry
- `DELETE /:id`: Delete trade log entry

### Credits (`/api/v1/credits`)

- `GET /balance`: Get user's credit balance
- `GET /history`: Get credit transaction history
- `GET /packages`: Get available recharge packages
- `GET /config`: Get current credit configuration
- `POST /recharge/package`: Recharge with predefined package
- `POST /recharge/custom`: Custom recharge amount
- `POST /bonus`: Add bonus credits (admin)
- `PUT /config`: Update credit configuration (admin)

### Notifications (`/api/v1/notifications`)

- `GET /`: Get user notifications with pagination
- `GET /unread-count`: Get count of unread notifications
- `PUT /:id/read`: Mark notification as read
- `PUT /mark-all-read`: Mark all notifications as read
- `POST /`: Create new notification
- `DELETE /:id`: Delete notification

### Payments (`/api/v1/payments`)

- `POST /create-order`: Create a new payment order with Cashfree
- `POST /webhook`: Handle Cashfree payment webhooks
- `GET /status/:orderId`: Get payment status for an order
- `GET /history`: Get user's payment history
- `GET /packages`: Get available recharge packages
- `POST /calculate`: Calculate credits for a given amount

## Project Structure

```
src/
├── config/
│   └── database.js          # Database configuration
├── controllers/             # Route controllers (if any)
├── data/                    # Static data files
│   ├── BSE.json            # BSE stock data
│   └── NSE.json            # NSE stock data
├── docs/                    # Documentation
├── index.js                 # Main application entry point
├── middleware/
│   └── auth.js             # JWT authentication middleware
├── models/                  # Mongoose models
│   ├── chatMessage.js      # Chat message model
│   ├── creditConfig.js     # Credit configuration model
│   ├── creditHistory.js    # Credit transaction history
│   ├── notification.js     # Notification model
│   ├── payment.js          # Payment order model
│   ├── stockLog.js         # Trade log model
│   ├── tokenBlacklist.js   # JWT token blacklist
│   └── user.js             # User model
├── routes/                  # API routes
│   ├── auth.js             # Authentication routes
│   ├── credits.js          # Credit management routes
│   ├── notifications.js    # Notification routes
│   ├── stock.js            # Stock search/details routes
│   ├── stockLog.js         # Trade logging routes
│   ├── watchlist.js        # Watchlist management routes
│   └── payments.js         # Payment processing routes
├── services/               # Business logic services
│   ├── credit/             # Credit system services
│   ├── email/              # Email services
│   ├── firebase/           # Firebase integration
│   ├── messaging/          # Messaging services
│   ├── n8n/               # n8n workflow integration
│   └── payment/            # Payment integration services
└── utils/                  # Utility functions
    ├── stock.js            # Stock data utilities
    └── validation.js       # Input validation
```

## Development Scripts

- `npm start`: Start production server
- `npm run dev`: Start development server with nodemon
- `npm run lint`: Run ESLint
- `npm run lint:fix`: Fix ESLint issues
- `npm run format`: Format code with Prettier
- `npm run format:check`: Check code formatting

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License. 
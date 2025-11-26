import axios from 'axios';
import crypto from 'crypto';
import { Payment } from '../../models/payment.js';
import { User } from '../../models/user.js';

class CashfreeService {
  constructor() {
    this.baseURL = process.env.NODE_ENV === 'production' ?
    'https://api.cashfree.com/pg' :
    'https://sandbox.cashfree.com/pg';

    this.appId = process.env.NODE_ENV === 'production' ? process.env.CASHFREE_APP_ID : process.env.CASHFREE_APP_ID_TEST;
    this.secretKey = process.env.NODE_ENV === 'production' ? process.env.CASHFREE_SECRET_KEY : process.env.CASHFREE_SECRET_KEY_TEST;
    this.apiVersion = '2025-01-01';
  }

  /**
   * Generate headers for Cashfree API calls
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-version': this.apiVersion,
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey
    };
  }

  /**
   * Create a new order with Cashfree
   */
  async createOrder(userId, amount, packageType = null) {
    try {
      // Get user details
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Calculate credits for the amount (deprecated - use subscriptions instead)
      const credits = Math.floor(amount / 0.5); // Simple calculation

      // Prepare order data for Cashfree (minimal required fields)
      const orderData = {
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: userId,
          customer_phone: user.mobileNumber || "9999999999"
        }
      };

      // Add optional fields if available
      if (user.firstName && user.lastName) {
        orderData.customer_details.customer_name = `${user.firstName} ${user.lastName}`;
      }

      if (user.email) {
        orderData.customer_details.customer_email = user.email;
      }

      // Add return URL for Cashfree to redirect after payment
      orderData.order_meta = {
        return_url: `https://www.nolojik.com/logdhan/thankyou`,
        notify_url: `${process.env.BACKEND_URL}/api/payments/webhook`
      };

      // Create order with Cashfree
      const response = await axios.post(
        `${this.baseURL}/orders`,
        orderData,
        { headers: this.getHeaders() }
      );

      const { payment_session_id, order_id } = response.data;

      // Save order to database
      const payment = new Payment({
        user: userId,
        orderId: order_id,
        paymentSessionId: payment_session_id,
        amount: amount,
        credits: credits,
        status: 'PENDING',
        orderCreatedAt: new Date(),
        metadata: {
          packageType,
          cashfreeOrderData: response.data
        }
      });

      await payment.save();

      return {
        success: true,
        data: {
          orderId: order_id,
          paymentSessionId: payment_session_id,
          amount: amount,
          credits: credits,
          paymentUrl: `https://www.nolojik.com/logdhan/checkout?sessionId=${payment_session_id}&amount=${amount}&orderId=${order_id}&type=payment`,
          returnUrl: orderData.order_meta.return_url
        }
      };

    } catch (error) {
      console.error('Error creating Cashfree order:', error);
      console.error('Error response data:', error.response?.data);
      console.error('Error response status:', error.response?.status);
      console.error('Error response headers:', error.response?.headers);

      if (error.response?.data) {
        throw new Error(`Cashfree Error: ${JSON.stringify(error.response.data)}`);
      } else {
        throw new Error(error.message || 'Failed to create payment order');
      }
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    try {
      const expectedSignature = crypto.
      createHmac('sha256', this.secretKey).
      update(payload).
      digest('hex');

      return signature === expectedSignature;
    } catch (error) {
      console.error('Error verifying webhook signature:', error);
      return false;
    }
  }

  /**
   * Process webhook from Cashfree
   */
  async processWebhook(webhookData, signature) {
    try {
      // Verify webhook signature
      const payload = JSON.stringify(webhookData);
      if (!this.verifyWebhookSignature(payload, signature)) {
        throw new Error('Invalid webhook signature');
      }

      const { order_id, payment_status, payment_method, payment_amount } = webhookData;

      // Find payment record
      const payment = await Payment.findByOrderId(order_id);
      if (!payment) {
        throw new Error('Payment order not found');
      }

      // Update payment status based on webhook
      if (payment_status === 'SUCCESS') {
        await payment.markAsSuccess({
          paymentMethod: payment_method,
          paymentAmount: payment_amount,
          cashfreeData: webhookData
        });

        // Credit addition is now handled by subscription system

        // Package assignment is now handled by subscription system

        return {
          success: true,
          message: 'Payment processed successfully',
          orderId: order_id,
          creditsAdded: payment.credits
        };

      } else if (payment_status === 'FAILED') {
        await payment.markAsFailed({
          reason: webhookData.payment_message || 'Payment failed',
          cashfreeData: webhookData
        });

        return {
          success: false,
          message: 'Payment failed',
          orderId: order_id
        };

      } else {
        // Handle other statuses (PENDING, EXPIRED, etc.)
        payment.status = payment_status.toUpperCase();
        payment.cashfreeData = webhookData;
        await payment.save();
      }

    } catch (error) {
      console.error('Error processing webhook:', error);
      throw error;
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(orderId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/orders/${orderId}`,
        { headers: this.getHeaders() }
      );

      return response.data;
    } catch (error) {
      console.error('Error getting payment status:', error);
      throw new Error('Failed to get payment status');
    }
  }

  /**
   * Get user's payment history
   */
  async getUserPayments(userId, limit = 20, skip = 0) {
    try {
      const payments = await Payment.getUserPayments(userId, limit, skip);

      return payments.map((payment) => ({
        id: payment._id,
        orderId: payment.orderId,
        amount: payment.amount,
        credits: payment.credits,
        status: payment.status,
        paymentMethod: payment.paymentMethod,
        createdAt: payment.createdAt,
        completedAt: payment.paymentCompletedAt
      }));
    } catch (error) {
      console.error('Error getting user payments:', error);
      throw new Error('Failed to get payment history');
    }
  }
}

export const cashfreeService = new CashfreeService();
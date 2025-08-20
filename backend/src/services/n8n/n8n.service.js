import axios from 'axios';

class N8nService {
  constructor() {
    this.webhookBaseUrl = process.env.N8N_WEBHOOK_BASE_URL;
    this.aiReviewWebhookId = process.env.N8N_AI_REVIEW_WEBHOOK_ID;
  }

  /**
   * Triggers an AI review workflow in n8n for trade log analysis
   * @param {Array} tradeLogData - Array of trade log objects to review
   * @returns {Promise<{success: boolean, response: any}>}
   */
  async triggerAIReview(tradeLogData) {
    try {
      const webhookUrl = `${this.webhookBaseUrl}${this.aiReviewWebhookId}`;
      
      // Send the first trade object directly (same as Postman format)
      const tradeObject = tradeLogData[0]; // Get the first trade from the array
      
      console.log('Sending to n8n webhook:', JSON.stringify(tradeObject, null, 2));
      console.log('Webhook URL:', webhookUrl);
      
      const response = await axios.post(webhookUrl, tradeObject);

      console.log('n8n response:', response.data);

      return {
        success: true,
        response: response.data
      };
    } catch (error) {
      console.error('Error triggering AI review workflow:', error.message);
      console.error('Error details:', error.response?.data || error);
      
      // Return error response instead of throwing to handle gracefully
      return {
        success: false,
        response: {
          error: 'Failed to trigger AI review workflow',
          details: error.message
        }
      };
    }
  }


  /**
   * Validates an incoming webhook request from n8n
   * @param {Object} headers - Request headers
   * @returns {boolean}
   */
  validateWebhookRequest(headers) {
    const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
    return headers['x-n8n-signature'] === webhookSecret;
  }
}

export const n8nService = new N8nService(); 
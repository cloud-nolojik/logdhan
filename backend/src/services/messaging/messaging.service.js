import { InfobipProvider } from './infobip.provider.js';

/**
 * Messaging service using Infobip WhatsApp provider
 */
export class MessagingService {
  constructor() {
    this.infobipProvider = null;
  }

  /**
   * Initialize the messaging service with Infobip provider
   */
  async initialize() {
    // Check if Infobip config is available
    if (process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL && process.env.INFOBIP_FROM_NUMBER) {
      try {
        // Initialize Infobip provider
        this.infobipProvider = new InfobipProvider({
          apiKey: process.env.INFOBIP_API_KEY,
          baseUrl: process.env.INFOBIP_BASE_URL,
          fromNumber: process.env.INFOBIP_FROM_NUMBER,
          webhookUrl: process.env.INFOBIP_WEBHOOK_URL
        });
        await this.infobipProvider.initialize();
        
        console.log('✅ Infobip WhatsApp provider initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize Infobip provider:', error.message);
        throw error;
      }
    } else {
      const missingVars = [];
      if (!process.env.INFOBIP_API_KEY) missingVars.push('INFOBIP_API_KEY');
      if (!process.env.INFOBIP_BASE_URL) missingVars.push('INFOBIP_BASE_URL');
      if (!process.env.INFOBIP_FROM_NUMBER) missingVars.push('INFOBIP_FROM_NUMBER');
      
      console.warn(`⚠️  Missing Infobip environment variables: ${missingVars.join(', ')}`);
      console.warn('⚠️  OTP sending will be disabled.');
    }
  }

  /**
   * Send OTP via Infobip WhatsApp
   */
  async sendOTP(mobileNumber, otp) {
    if (!this.infobipProvider) {
      throw new Error('Infobip provider not initialized. Check environment variables.');
    }

    return await this.infobipProvider.sendMessage({
      to: mobileNumber,
      templateName: 'otp',
      templateData: {
        otp: otp,
        appName: process.env.APP_NAME || 'LogDhan'
      }
    });
  }

  /**
   * Send analysis service update notification via WhatsApp
   */
  async sendAnalysisServiceUpdate(mobileNumber, analysisData) {
    if (!this.infobipProvider) {
      console.warn('⚠️ Infobip provider not initialized. Analysis service update not sent.');
      return null;
    }

    try {
      return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'analysis_service_update',
        templateData: {
          userName: analysisData.userName || 'logdhanuser',
          stocksWithFeedback: `${analysisData.stocksProcessed || 0} stocks`
        }
      });
    } catch (error) {
      console.error('❌ Failed to send analysis service update:', error.message);
      throw error;
    }
  }

  /**
   * Send monitoring conditions met alert via WhatsApp
   */
  async sendMonitoringConditionsMet(mobileNumber, alertData) {
    if (!this.infobipProvider) {
      console.warn('⚠️ Infobip provider not initialized. Monitoring alert not sent.');
      return null;
    }

    try {
      return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'monitoring_conditions_met',
        templateData: {
          userName: alertData.userName || 'logdhanuser',
          stockSymbol: alertData.stockSymbol || 'Stock',
          instrumentKey: alertData.instrumentKey || ''
        }
      });
    } catch (error) {
      console.error('❌ Failed to send monitoring conditions met alert:', error.message);
      throw error;
    }
  }

  /**
   * Send bulk analysis available notification via WhatsApp
   */
  async sendBulkAnalysisAvailable(mobileNumber, notificationData) {
    if (!this.infobipProvider) {
      console.warn('⚠️ Infobip provider not initialized. Bulk analysis notification not sent.');
      return null;
    }

    try {
      return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'bulk_analysis_available',
        templateData: {
          userName: notificationData.userName || 'User',
          time: notificationData.time || '5:00 PM'
        }
      });
    } catch (error) {
      console.error('❌ Failed to send bulk analysis available notification:', error.message);
      throw error;
    }
  }

  /**
   * Get message delivery status
   */
  async getMessageStatus(messageId) {
    if (!this.infobipProvider) {
      throw new Error('Infobip provider not initialized');
    }

    return await this.infobipProvider.getMessageStatus(messageId);
  }
}

// Create and export a singleton instance
export const messagingService = new MessagingService(); 
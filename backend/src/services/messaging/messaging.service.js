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
   * Send strategy alert via WhatsApp when trigger conditions are met
   */
  async sendStrategyAlert(mobileNumber, strategyData) {
    if (!this.infobipProvider) {
      console.warn('⚠️ Infobip provider not initialized. Strategy alert not sent.');
      return null;
    }

    try {
      return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'strategy_alert',
        templateData: {
          stock_name: strategyData.stock_name,
          entry_price: `₹${strategyData.entry_price}`,
          target_price: `₹${strategyData.target_price}`,
          stop_loss: `₹${strategyData.stop_loss}`,
          strategy_type: strategyData.strategy_type,
          current_price: `₹${strategyData.current_price}`,
          triggers_satisfied: strategyData.triggers_satisfied || 'All trigger conditions met',
          next_action: strategyData.next_action || 'Open LogDhan app to place order'
        }
      });
    } catch (error) {
      console.error('❌ Failed to send strategy alert:', error.message);
      throw error;
    }
  }

  /**
   * Send analysis completion notification via WhatsApp
   */
  async sendAnalysisComplete(mobileNumber, analysisData) {
    if (!this.infobipProvider) {
      console.warn('⚠️ Infobip provider not initialized. Analysis complete notification not sent.');
      return null;
    }

    try {
      return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'analysis_complete',
        templateData: {
          stock_name: analysisData.stock_name,
          strategies_count: analysisData.strategies_count.toString(),
          analysis_type: analysisData.analysis_type
        }
      });
    } catch (error) {
      console.error('❌ Failed to send analysis complete notification:', error.message);
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
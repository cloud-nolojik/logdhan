import { MessagingProvider } from './provider.js';
import https from 'follow-redirects/https.js';

/**
 * Infobip WhatsApp messaging provider
 */
export class InfobipProvider extends MessagingProvider {
  constructor(config) {
    super(config);
    this.templates = {
      otp: {
        templateName: 'logdhan_otp_verify', // Your Infobip template name
        templateId: '1277969390643822', // Your Infobip template ID
        language: 'en_GB',
        placeholderCount: 1 // Only OTP
      },
      strategy_alert: {
        templateName: 'logdhan_strategy_alert', // Template for strategy trigger alerts
        templateId: '1339203531328157', // Your Infobip template ID
        language: 'en',
        placeholderCount: 8 // stock_name, entry_price, target_price, stop_loss, strategy_type, current_price, triggers_satisfied, next_action
      },
      analysis_complete: {
        templateName: 'logdhan_analysis_complete', // Template for analysis completion
        templateId: 'TBD', // You'll need to provide this after creating the template
        language: 'en',
        placeholderCount: 3, // stock_name, strategies_count, analysis_type
        hasHeader: true // This template has a header section
      }
    };
  }

  async initialize() {
    // Validate required config
    const requiredFields = ['apiKey', 'baseUrl', 'fromNumber'];
    for (const field of requiredFields) {
      if (!this.config[field]) {
        throw new Error(`Infobip provider requires ${field}`);
      }
    }

    this.hostname = this.config.baseUrl.replace('https://', '').replace('http://', '');
    this.headers = {
      'Authorization': `App ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  async sendMessage({ to, templateName, templateData }) {
    const template = this.templates[templateName];
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }

    // Ensure phone number is in correct format
     let formattedNumber = to;
    // if (!formattedNumber.startsWith('+')) {
    //   formattedNumber = '+' + formattedNumber;
    // }

    // Build content based on template type
    let content = {
      templateName: template.templateName,
      templateData: {
        body: {
          placeholders: this.buildPlaceholders(templateName, templateData)
        }
      },
      language: template.language
    };

    // Add header for templates that have it
    if (template.hasHeader) {
      content.templateData.header = {
        type: "TEXT"
      };
    }

    // Add buttons only for OTP template
    if (templateName === 'otp') {
      content.templateData.buttons = [
        {
          type: "URL",
          parameter: templateData.otp || "000000"
        }
      ];
    }

    const postData = {
      messages: [
        {
          from: this.config.fromNumber,
          to: formattedNumber,
          content: content
        }
      ]
    };

    return new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        hostname: this.hostname,
        path: '/whatsapp/1/message/template',
        headers: this.headers,
        maxRedirects: 20
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            const response = JSON.parse(body.toString());
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('✅ Infobip WhatsApp message sent successfully:', response);
              resolve(response);
            } else {
              console.error('❌ Infobip API error:', response);
              reject(new Error(`Infobip API error: ${response.requestError?.serviceException?.text || 'Unknown error'}`));
            }
          } catch (parseError) {
            console.error('❌ Failed to parse Infobip response:', parseError);
            reject(new Error('Failed to parse Infobip response'));
          }
        });

        res.on('error', (error) => {
          console.error('❌ Infobip request error:', error);
          reject(error);
        });
      });

      req.on('error', (error) => {
        console.error('❌ Infobip connection error:', error);
        reject(error);
      });

      req.write(JSON.stringify(postData));
      req.end();
    });
  }

  /**
   * Build placeholders array based on template type and data
   */
  buildPlaceholders(templateName, templateData) {
    switch (templateName) {
      case 'otp':
        return [
          templateData.otp || '000000'
        ];
      case 'strategy_alert':
        return [
          templateData.stock_name || 'UNKNOWN',
          templateData.entry_price || '0',
          templateData.target_price || '0',
          templateData.stop_loss || '0',
          templateData.strategy_type || 'BUY',
          templateData.current_price || '0',
          templateData.triggers_satisfied || 'All conditions met',
          templateData.next_action || 'Review and place order manually'
        ];
      case 'analysis_complete':
        return [
          templateData.stock_name || 'UNKNOWN',
          templateData.strategies_count || '0',
          templateData.analysis_type || 'swing'
        ];
      default:
        return [];
    }
  }

  /**
   * Generate unique message ID
   */
  generateMessageId() {
    return `logdhan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async getTemplates() {
    return Object.keys(this.templates);
  }

  /**
   * Get delivery status of a message
   */
  async getMessageStatus(messageId) {
    return new Promise((resolve, reject) => {
      const options = {
        method: 'GET',
        hostname: this.hostname,
        path: `/whatsapp/1/reports?messageId=${messageId}`,
        headers: {
          'Authorization': `App ${this.config.apiKey}`,
          'Accept': 'application/json'
        },
        maxRedirects: 20
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            const response = JSON.parse(body.toString());
            resolve(response);
          } catch (parseError) {
            reject(new Error('Failed to parse status response'));
          }
        });

        res.on('error', (error) => {
          reject(error);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }
}
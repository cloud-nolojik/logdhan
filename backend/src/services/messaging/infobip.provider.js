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
      }
      // Add more templates as needed
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

    const postData = {
      messages: [
        {
          from: this.config.fromNumber,
          to: formattedNumber,
          content: {
            templateName: template.templateName,
            templateData: {
              body: {
                placeholders: this.buildPlaceholders(templateName, templateData)
              },
              buttons: [
                {
                  type: "URL",
                  parameter: templateData.otp || "000000"
                }
              ]
            },
            language: template.language
          }
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
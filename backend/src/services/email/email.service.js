import { Client } from 'postmark';

class EmailService {
  constructor() {
    this.client = new Client(process.env.POSTMARK_TOKEN);
    this.fromEmail = process.env.FROM_EMAIL || 'info@nolojik.com';
  }

  /**
   * Send CSV export email to user
   * @param {string} userEmail - User's email address
   * @param {string} userName - User's name for personalization
   * @param {string} csvContent - CSV file content
   * @param {string} filename - CSV filename
   * @param {Object} exportParams - Export parameters for email context
   */
  async sendCSVExport(userEmail, userName, csvContent, filename, exportParams = {}) {
    try {
      const { startDate, endDate, totalTrades } = exportParams;
      
      // Create date range text for email
      let dateRangeText = 'all your trade logs';
      if (startDate && endDate) {
        dateRangeText = `trade logs from ${startDate} to ${endDate}`;
      } else if (startDate) {
        dateRangeText = `trade logs from ${startDate} onwards`;
      } else if (endDate) {
        dateRangeText = `trade logs up to ${endDate}`;
      }

      const emailBody = `
        <html>
        <head>
          <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
            .highlight { background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .stats { display: flex; justify-content: space-around; margin: 20px 0; }
            .stat-item { text-align: center; }
            .stat-number { font-size: 24px; font-weight: bold; color: #667eea; }
            .stat-label { font-size: 12px; color: #666; }
            .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📊 Your Trade Log Export</h1>
              <p>LogDhan - Smart Trading Analytics</p>
            </div>
            
            <div class="content">
              <h2>Hi ${userName || 'Trader'}! 👋</h2>
              
              <p>Your requested trade log export is ready! We've generated a comprehensive CSV file containing ${dateRangeText}.</p>
              
              <div class="highlight">
                <h3>📈 Export Summary</h3>
                <div class="stats">
                  <div class="stat-item">
                    <div class="stat-number">${totalTrades || 0}</div>
                    <div class="stat-label">Total Trades</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-number">${filename.split('_')[2]?.split('.')[0] || 'Latest'}</div>
                    <div class="stat-label">Export Date</div>
                  </div>
                </div>
              </div>
              
              <h3>📋 What's included in your export:</h3>
              <ul>
                <li><strong>Trade Details:</strong> Stock symbols, directions, quantities, prices</li>
                <li><strong>Risk Management:</strong> Stop loss and target price information</li>
                <li><strong>AI Analysis:</strong> Review status and AI insights</li>
                <li><strong>Timestamps:</strong> Trade creation and execution dates</li>
                <li><strong>Metadata:</strong> Terms, tags, and execution status</li>
              </ul>
              
              <div class="highlight">
                <h3>💡 Pro Tip</h3>
                <p>Import this CSV into Excel, Google Sheets, or your favorite analytics tool to create custom charts and track your trading performance over time!</p>
              </div>
              
              <p>The CSV file is attached to this email. You can open it with any spreadsheet application like Excel, Google Sheets, or Numbers.</p>
              
              <p>Keep tracking, keep improving! 📈</p>
              
              <p>Best regards,<br>
              <strong>The LogDhan Team</strong></p>
            </div>
            
            <div class="footer">
              <p>LogDhan - Empowering Smart Trading Decisions</p>
              <p style="font-size: 12px;">This email was generated automatically. Please don't reply to this email.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const response = await this.client.sendEmail({
        From: this.fromEmail,
        To: userEmail,
        Subject: `📊 Your LogDhan Trade Export - ${totalTrades || 0} trades (${new Date().toLocaleDateString()})`,
        HtmlBody: emailBody,
        Attachments: [
          {
            Name: filename,
            Content: Buffer.from(csvContent).toString('base64'),
            ContentType: 'text/csv'
          }
        ],
        Tag: 'trade-export'
      });

      console.log('Export email sent successfully:', response.MessageID);
      return {
        success: true,
        messageId: response.MessageID
      };

    } catch (error) {
      console.error('Error sending export email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send welcome email when user adds email
   * @param {string} userEmail - User's email address
   * @param {string} userName - User's name
   */
  async sendWelcomeEmail(userEmail, userName) {
    try {
      const emailBody = `
        <html>
        <head>
          <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
            .feature { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #667eea; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Welcome to LogDhan!</h1>
              <p>Smart Trading Analytics</p>
            </div>
            
            <div class="content">
              <h2>Hi ${userName || 'Trader'}! 👋</h2>
              
              <p>Thanks for adding your email to LogDhan! You can now receive your trade exports directly in your inbox.</p>
              
              <div class="feature">
                <h3>📊 Export Features Available</h3>
                <p>• <strong>CSV Downloads:</strong> Get your trade logs in spreadsheet format</p>
                <p>• <strong>Date Filtering:</strong> Export specific time periods</p>
                <p>• <strong>Email Delivery:</strong> Receive exports directly in your inbox</p>
                <p>• <strong>AI Analysis Included:</strong> Review results and insights</p>
              </div>
              
              <p>Start exporting your trade data anytime from the LogDhan app!</p>
              
              <p>Happy Trading! 📈</p>
              
              <p>Best regards,<br>
              <strong>The LogDhan Team</strong></p>
            </div>
          </div>
        </body>
        </html>
      `;

      const response = await this.client.sendEmail({
        From: this.fromEmail,
        To: userEmail,
        Subject: '🎉 Welcome to LogDhan - Email Exports Enabled!',
        HtmlBody: emailBody,
        Tag: 'welcome-email'
      });

      return {
        success: true,
        messageId: response.MessageID
      };

    } catch (error) {
      console.error('Error sending welcome email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export const emailService = new EmailService();
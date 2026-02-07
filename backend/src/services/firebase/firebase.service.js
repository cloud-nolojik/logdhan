import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { User } from '../../models/user.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

// Get the current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class FirebaseService {
  constructor() {
    // Initialize Firebase Admin SDK
    if (getApps().length === 0) {
      try {
        // Read the service account file
        const serviceAccountPath = resolve(__dirname, '../..', 'logdhan-6ea73-firebase-adminsdk-fbsvc-e04bf48534.json');
        const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

        initializeApp({
          credential: cert(serviceAccount)
        });

      } catch (error) {
        console.error('Error initializing Firebase Admin SDK:', error);
        throw error;
      }
    }

    // Get the messaging instance
    this.messaging = getMessaging();
  }

  /**
   * Send notification to multiple devices
   */
  async sendToDevices(tokens, title, body, data = {}) {
    try {
      if (!tokens || tokens.length === 0) {
        return { success: false, error: 'No tokens provided' };
      }

      const failedTokens = [];
      const sentMessages = [];

      for (const token of tokens) {
        if (!token) {
          continue;
        }
        // Ensure all data values are strings (Firebase requirement)
        const stringifiedData = {};
        for (const [key, value] of Object.entries(data)) {
          stringifiedData[key] = String(value);
        }

        const message = {
          notification: {
            title,
            body
          },
          data: {
            ...stringifiedData,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            channel_id: 'logdhan_notifications'
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'logdhan_notifications',
              priority: 'high',
              defaultSound: true
            }
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
                contentAvailable: true
              }
            }
          },
          token
        };

        try {
          const response = await this.messaging.send(message);

          sentMessages.push(response);
        } catch (error) {
          console.error(`Failed to send to token: ${token}`, error);
          failedTokens.push(token);
        }
      }

      return {
        success: true,
        successCount: sentMessages.length,
        failureCount: failedTokens.length,
        failedTokens
      };
    } catch (error) {
      console.error('Error sending notifications to devices:', error);
      return { success: false, error };
    }
  }
  /**
   * Send notification to a user (all their devices)
   */
  async sendToUser(userId, title, body, data = {}) {
    try {
      const user = await User.findById(userId);
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {

        return { success: false, error: 'No FCM tokens found' };
      }

      const result = await this.sendToDevices(user.fcmTokens, title, body, data);

      // Remove invalid tokens if any
      if (result.success && result.failedTokens?.length > 0) {
        await User.findByIdAndUpdate(userId, {
          $pull: { fcmTokens: { $in: result.failedTokens } }
        });
      }

      return result;
    } catch (error) {
      console.error('Error sending notification to user:', userId, error);
      return { success: false, error };
    }
  }

  /**
   * Send notification to a topic
   */
  async sendToTopic(topic, title, body, data = {}) {
    try {
      const message = {
        notification: {
          title,
          body
        },
        data: {
          ...data,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          channel_id: 'logdhan_notifications'
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'logdhan_notifications'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              contentAvailable: true
            }
          }
        },
        topic
      };

      const response = await this.messaging.send(message);

      return { success: true, messageId: response };
    } catch (error) {
      console.error('Error sending notification to topic:', error);
      return { success: false, error };
    }
  }

  /**
   * Send AI review notification
   */
  async sendAIReviewNotification(userId, stockSymbol, logId) {
    const title = 'AI Review Complete';
    const body = `AI review for ${stockSymbol} has been completed. Click to view details.`;

    // Include rich data for the notification
    const data = {
      type: 'AI_REVIEW',
      stockSymbol,
      logId,
      route: '/trade-log',
      timestamp: new Date().toISOString()
    };

    return this.sendToUser(userId, title, body, data);
  }

  /**
   * Send weekly setups alert notification
   */
  async sendWeeklySetupsAlert(userId, alertData) {
    const stockCount = alertData.stockCount || 0;
    const topPick = alertData.topPick || '';

    const title = 'Weekly Setups Ready!';
    const body = topPick
      ? `${stockCount} new setups available. Top pick: ${topPick}. Open app to view.`
      : `${stockCount} new setups available for this week. Open app to view.`;

    const data = {
      type: 'WEEKLY_SETUPS',
      stockCount: String(stockCount),
      topPick: topPick || '',
      route: '/setups/weekly',
      timestamp: new Date().toISOString()
    };

    return this.sendToUser(userId, title, body, data);
  }

  /**
   * Send notification to all users with FCM tokens
   * Used for broadcast notifications when analysis jobs complete
   */
  async sendAnalysisCompleteToAllUsers(title, body, data = {}) {
    try {
      const users = await User.find({ fcmTokens: { $exists: true, $ne: [] } }).lean();

      if (users.length === 0) {
        console.log('[Firebase] No users with FCM tokens found');
        return { success: true, successCount: 0, failureCount: 0 };
      }

      let successCount = 0;
      let failureCount = 0;

      for (const user of users) {
        try {
          const result = await this.sendToUser(user._id, title, body, data);
          if (result.success) {
            successCount++;
          } else {
            failureCount++;
          }
        } catch (err) {
          console.error(`[Firebase] Failed to send to user ${user._id}:`, err.message);
          failureCount++;
        }
      }

      console.log(`[Firebase] Broadcast complete: ${successCount} success, ${failureCount} failed`);
      return { success: true, successCount, failureCount };
    } catch (error) {
      console.error('[Firebase] Error in sendAnalysisCompleteToAllUsers:', error);
      return { success: false, error: error.message };
    }
  }
}

// Create and export a singleton instance
export const firebaseService = new FirebaseService();
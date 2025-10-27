/**
 * Common AI Model Selection Service
 * Provides centralized model determination logic for both aiAnalyze and aiReview services
 */

class ModelSelectorService {
    /**
     * Determine which AI model to use - simplified version that always returns the same models
     * @param {String} userId - User ID (optional)
     * @param {Boolean} isFromRewardedAd - Whether this is from a rewarded ad (optional)
     * @param {String} creditType - Type of credit (optional)
     * @returns {Object} - Model configuration and status
     */
    async determineAIModel(userId = null, isFromRewardedAd = false, creditType = 'regular') {
        // Simple model selection - just return the models to use
        return {
            canProceed: true,
            models: {
                analysis: "gpt-5",        // gpt-5 for analysis
                sentiment: "gpt-4o"       // gpt-4o for sentiment
            }
        };
    }

    /**
     * Legacy method for backward compatibility
     * @param {String} userId - User ID
     * @param {Boolean} isFromRewardedAd - Whether this is from a rewarded ad
     * @param {String} creditType - Type of credit
     * @returns {Object} - Model configuration
     */
    async getModelConfiguration(userId, isFromRewardedAd = false, creditType = 'regular') {
        return await this.determineAIModel(userId, isFromRewardedAd, creditType);
    }
}

export default new ModelSelectorService();
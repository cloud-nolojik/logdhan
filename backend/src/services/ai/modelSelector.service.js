/**
 * Common AI Model Selection Service
 * Provides centralized model determination logic for both aiAnalyze and aiReview services
 */

class ModelSelectorService {
    constructor() {
        // ========== SINGLE SOURCE OF TRUTH FOR ALL AI MODELS ==========
        // Update these values when changing models across the application
        this.models = {
            analysis: "gpt-5.2-2025-12-11",   // Main analysis model (Stage 3)
            sentiment: "gpt-5-mini-2025-08-07" // Sentiment analysis model (news/sector)
        };
    }

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
                analysis: this.models.analysis,     // gpt-5.2 for analysis
                sentiment: this.models.sentiment    // gpt-5-mini for sentiment
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
import { getModelPricing } from './aiModelPricing.js';

class AICostTracker {
  constructor() {
    this.sessionCosts = [];
    this.totalCost = 0;
  }

  /**
   * Calculate cost for an API call
   * @param {string} model - The model name (e.g., 'gpt-4o-mini')
   * @param {number} inputTokens - Number of input tokens
   * @param {number} outputTokens - Number of output tokens
   * @param {boolean} isCached - Whether input is cached
   * @param {string} callType - Type of call (e.g., 'sentiment', 'analysis')
   * @returns {object} Cost breakdown
   */
  calculateCost(model, inputTokens, outputTokens, isCached = false, callType = 'general') {
    const pricing = getModelPricing(model);
    
    // Calculate costs per million tokens
    const inputCostPerMillion = isCached && pricing.cachedInput ? pricing.cachedInput : pricing.input;
    const outputCostPerMillion = pricing.output;
    
    // Calculate actual cost
    const inputCost = (inputTokens / 1000000) * inputCostPerMillion;
    const outputCost = (outputTokens / 1000000) * outputCostPerMillion;
    const totalCost = inputCost + outputCost;
    
    // Create cost record
    const costRecord = {
      timestamp: new Date().toISOString(),
      model,
      callType,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputCost,
      outputCost,
      totalCost,
      isCached,
      costPerMillion: {
        input: inputCostPerMillion,
        output: outputCostPerMillion
      }
    };
    
    // Add to session costs
    this.sessionCosts.push(costRecord);
    this.totalCost += totalCost;
    
    return costRecord;
  }

  /**
   * Get session summary
   * @returns {object} Session cost summary
   */
  getSessionSummary() {
    const summary = {
      totalCost: this.totalCost,
      callCount: this.sessionCosts.length,
      byCallType: {},
      byModel: {},
      totalTokens: {
        input: 0,
        output: 0,
        total: 0
      }
    };
    
    // Aggregate by call type and model
    this.sessionCosts.forEach(cost => {
      // By call type
      if (!summary.byCallType[cost.callType]) {
        summary.byCallType[cost.callType] = {
          count: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0
        };
      }
      summary.byCallType[cost.callType].count++;
      summary.byCallType[cost.callType].totalCost += cost.totalCost;
      summary.byCallType[cost.callType].inputTokens += cost.inputTokens;
      summary.byCallType[cost.callType].outputTokens += cost.outputTokens;
      
      // By model
      if (!summary.byModel[cost.model]) {
        summary.byModel[cost.model] = {
          count: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0
        };
      }
      summary.byModel[cost.model].count++;
      summary.byModel[cost.model].totalCost += cost.totalCost;
      summary.byModel[cost.model].inputTokens += cost.inputTokens;
      summary.byModel[cost.model].outputTokens += cost.outputTokens;
      
      // Total tokens
      summary.totalTokens.input += cost.inputTokens;
      summary.totalTokens.output += cost.outputTokens;
      summary.totalTokens.total += cost.totalTokens;
    });
    
    return summary;
  }

  /**
   * Reset session costs
   */
  resetSession() {
    this.sessionCosts = [];
    this.totalCost = 0;
  }

  /**
   * Get formatted cost string
   * @param {number} cost - Cost in USD
   * @returns {string} Formatted cost string
   */
  formatCost(cost) {
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Get detailed cost breakdown string
   * @returns {string} Formatted cost breakdown
   */
  getCostBreakdown() {
    const summary = this.getSessionSummary();
    let breakdown = '\n💰 AI API Cost Summary:\n';
    breakdown += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    breakdown += `Total Cost: ${this.formatCost(summary.totalCost)}\n`;
    breakdown += `Total Calls: ${summary.callCount}\n`;
    breakdown += `Total Tokens: ${summary.totalTokens.total.toLocaleString()}\n\n`;
    
    breakdown += `📊 Cost by Call Type:\n`;
    Object.entries(summary.byCallType).forEach(([type, data]) => {
      breakdown += `  ${type}: ${this.formatCost(data.totalCost)} (${data.count} calls)\n`;
    });
    
    breakdown += `\n🤖 Cost by Model:\n`;
    Object.entries(summary.byModel).forEach(([model, data]) => {
      breakdown += `  ${model}: ${this.formatCost(data.totalCost)} (${data.count} calls)\n`;
    });
    
    breakdown += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    return breakdown;
  }
}

// Export singleton instance
export const aiCostTracker = new AICostTracker();

// Export class for testing
export default AICostTracker;
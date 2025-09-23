// Simplified version that trusts GPT-5's response
async generateStockAnalysisWithPayloadSimplified({ stock_name, stock_symbol, current_price, analysis_type, marketPayload, sentiment }) {
    const analysisStartTime = Date.now();
    
    // Build prompt with actual values
    const prompt = `
You are a professional stock analyst. Output MUST be valid JSON only.
Use ONLY fields present in MARKET DATA. Return EXACTLY ONE strategy.

ANALYZE: ${stock_name} (${stock_symbol}) for ${analysis_type} opportunities.

MARKET DATA (authoritative):
${JSON.stringify(marketPayload, null, 2)}

CONTEXT:
- Current Price: ₹${current_price}
- Analysis Type: ${analysis_type}
- Market Sentiment: ${sentiment || 'neutral'}
- Volume Classification: ${marketPayload?.volumeContext?.classification || 'UNKNOWN'}

[Rest of your prompt template...]
`;

    try {
        // Call GPT-5
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: this.analysisModel, // gpt-5
            messages: [
                { role: 'system', content: 'You are a professional stock analyst.' },
                { role: 'user', content: prompt }
            ],
            response_format: { type: "json_object" }
        }, {
            headers: {
                'Authorization': `Bearer ${this.openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Parse response
        const parsed = JSON.parse(response.data.choices[0].message.content);
        
        // MINIMAL post-processing - only essentials
        
        // 1. Use pre-calculated volume if AI missed it
        if (parsed.market_summary && (!parsed.market_summary.volume || parsed.market_summary.volume === 'UNKNOWN')) {
            parsed.market_summary.volume = marketPayload?.volumeContext?.classification || 'UNKNOWN';
        }
        
        // 2. Add metadata (optional, for debugging)
        parsed.meta = {
            model_used: this.analysisModel,
            processing_time_ms: Date.now() - analysisStartTime,
            data_timestamp: marketPayload?.snapshots?.lastBars1h?.slice(-1)?.[0]?.[0] || null
        };
        
        // 3. That's it! Trust GPT-5's response
        return parsed;
        
    } catch (error) {
        console.error('❌ AI Analysis failed:', error);
        
        // Return simple error response
        return {
            schema_version: "1.4",
            symbol: stock_symbol,
            analysis_type,
            insufficientData: true,
            error: error.message,
            strategies: [],
            disclaimer: "Analysis failed. Please try again."
        };
    }
}
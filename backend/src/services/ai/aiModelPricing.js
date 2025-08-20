// AI Model Pricing Configuration
// All prices are per 1M tokens in USD

export const AI_MODEL_PRICING = {
  // GPT-5 Series
  'gpt-5': {
    input: 1.25,
    cachedInput: 0.125,
    output: 10.00
  },
  'gpt-5-mini': {
    input: 0.25,
    cachedInput: 0.025,
    output: 2.00
  },
  'gpt-5-nano': {
    input: 0.05,
    cachedInput: 0.005,
    output: 0.40
  },
  'gpt-5-chat-latest': {
    input: 1.25,
    cachedInput: 0.125,
    output: 10.00
  },
  
  // GPT-4.1 Series
  'gpt-4.1': {
    input: 2.00,
    cachedInput: 0.50,
    output: 8.00
  },
  'gpt-4.1-mini': {
    input: 0.40,
    cachedInput: 0.10,
    output: 1.60
  },
  'gpt-4.1-nano': {
    input: 0.10,
    cachedInput: 0.025,
    output: 0.40
  },
  
  // GPT-4o Series
  'gpt-4o': {
    input: 2.50,
    cachedInput: 1.25,
    output: 10.00
  },
  'gpt-4o-2024-05-13': {
    input: 5.00,
    cachedInput: null,
    output: 15.00
  },
  'gpt-4o-audio-preview': {
    input: 2.50,
    cachedInput: null,
    output: 10.00
  },
  'gpt-4o-realtime-preview': {
    input: 5.00,
    cachedInput: 2.50,
    output: 20.00
  },
  'gpt-4o-mini': {
    input: 0.15,
    cachedInput: 0.075,
    output: 0.60
  },
  'gpt-4o-mini-audio-preview': {
    input: 0.15,
    cachedInput: null,
    output: 0.60
  },
  'gpt-4o-mini-realtime-preview': {
    input: 0.60,
    cachedInput: 0.30,
    output: 2.40
  },
  
  // O-Series Models
  'o1': {
    input: 15.00,
    cachedInput: 7.50,
    output: 60.00
  },
  'o1-pro': {
    input: 150.00,
    cachedInput: null,
    output: 600.00
  },
  'o3-pro': {
    input: 20.00,
    cachedInput: null,
    output: 80.00
  },
  'o3': {
    input: 2.00,
    cachedInput: 0.50,
    output: 8.00
  },
  'o3-deep-research': {
    input: 10.00,
    cachedInput: 2.50,
    output: 40.00
  },
  'o4-mini': {
    input: 1.10,
    cachedInput: 0.275,
    output: 4.40
  },
  'o4-mini-deep-research': {
    input: 2.00,
    cachedInput: 0.50,
    output: 8.00
  },
  'o3-mini': {
    input: 1.10,
    cachedInput: 0.55,
    output: 4.40
  },
  'o1-mini': {
    input: 1.10,
    cachedInput: 0.55,
    output: 4.40
  },
  
  // Codex Models
  'codex-mini-latest': {
    input: 1.50,
    cachedInput: 0.375,
    output: 6.00
  },
  
  // Search Preview Models
  'gpt-4o-mini-search-preview': {
    input: 0.15,
    cachedInput: null,
    output: 0.60
  },
  'gpt-4o-search-preview': {
    input: 2.50,
    cachedInput: null,
    output: 10.00
  },
  
  // Computer Use Preview
  'computer-use-preview': {
    input: 3.00,
    cachedInput: null,
    output: 12.00
  },
  
  // Image Models
  'gpt-image-1': {
    input: 5.00,
    cachedInput: 1.25,
    output: null
  }
};

// Default model if not found in pricing
export const DEFAULT_MODEL = 'gpt-4o-mini';

// Function to get model pricing with fallback
export function getModelPricing(modelName) {
  return AI_MODEL_PRICING[modelName] || AI_MODEL_PRICING[DEFAULT_MODEL];
}
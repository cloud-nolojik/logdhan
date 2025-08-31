// Trading Terms Configuration with Clear Timelines
export const TRADING_TERMS = {
  intraday: {
    key: 'intraday',
    label: 'Intraday',
    displayName: 'Intraday (Same Day)',
    timeline: 'Exit same day',
    duration: '1 day',
    description: 'Enter and exit positions within the same trading day',
    holdingPeriod: '9:15 AM - 3:30 PM',
    riskLevel: 'High',
    suitableFor: 'Active traders',
    keyPoints: [
      'No overnight risk',
      'Requires constant monitoring',
      'Quick decision making'
    ]
  },
  short: {
    key: 'short',
    label: 'Short-term',
    displayName: 'Short-term Swing',
    timeline: '2-10 days',
    duration: '1-2 weeks',
    description: 'Hold positions for several days to capture short-term price movements',
    holdingPeriod: '2 to 10 trading days',
    riskLevel: 'Medium-High',
    suitableFor: 'Swing traders',
    keyPoints: [
      'Overnight holding risk',
      'Less monitoring needed than intraday',
      'Captures multi-day trends'
    ]
  },
  medium: {
    key: 'medium',
    label: 'Medium-term',
    displayName: 'Medium-term/Positional',
    timeline: '3-12 weeks',
    duration: 'Few weeks to months',
    description: 'Hold positions for weeks to months to capture larger market moves',
    holdingPeriod: '3 weeks to 3 months',
    riskLevel: 'Medium',
    suitableFor: 'Position traders',
    keyPoints: [
      'Lower stress than short-term',
      'Follows major trends',
      'Requires patience'
    ]
  }
};

// Helper function to get term details
export const getTermDetails = (termKey) => {
  return TRADING_TERMS[termKey] || null;
};

// Helper function to get all term keys
export const getTermKeys = () => {
  return Object.keys(TRADING_TERMS);
};

// Helper function to validate term
export const isValidTerm = (term) => {
  return term && TRADING_TERMS.hasOwnProperty(term.toLowerCase());
};

// Get term for display (returns formatted object for UI)
export const getTermForDisplay = (termKey) => {
  const term = TRADING_TERMS[termKey];
  if (!term) return null;
  
  return {
    value: term.key,
    label: term.displayName,
    timeline: term.timeline,
    description: term.description,
    badge: term.duration,
    riskLevel: term.riskLevel
  };
};

// Get all terms for dropdown/selection (exclude medium-term for mobile app)
export const getTermsForSelection = () => {
  return Object.values(TRADING_TERMS)
    .filter(term => term.key !== 'medium') // Remove medium-term from mobile app options
    .map(term => ({
      value: term.key,
      label: term.displayName,
      timeline: term.timeline,
      description: term.description,
      badge: term.duration,
      riskLevel: term.riskLevel,
      keyPoints: term.keyPoints || [],
      suitableFor: term.suitableFor || "",
      holdingPeriod: term.holdingPeriod || ""
    }));
};

// Format term for display in buttons/cards
export const formatTermForButton = (termKey) => {
  const term = TRADING_TERMS[termKey];
  if (!term) return termKey;
  
  return `${term.displayName} (${term.timeline})`;
};

export default TRADING_TERMS;
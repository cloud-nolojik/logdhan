/**
 * Sector mapping and NIFTY index correlation utility
 */

// Major Indian sector classifications with representative stocks
export const SECTOR_MAPPING = {
    // Technology & IT Services
    'TECH': {
        name: 'Information Technology',
        index: 'NIFTY IT',
        keywords: ['tech', 'technology', 'software', 'IT', 'digital', 'cyber', 'AI', 'artificial intelligence'],
        companies: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM', 'COFORGE', 'MINDTREE', 'KPITTECH', 'NEWGEN', 'BSOFT', 'ECLERX', 'TBOTEK'],
        nifty_weight: 'High' // Major weight in NIFTY 50
    },
    
    // Banking & Financial Services
    'BANKING': {
        name: 'Banking & Financial Services',
        index: 'NIFTY BANK',
        keywords: ['bank', 'banking', 'financial', 'finance', 'loan', 'credit', 'NBFC'],
        companies: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK', 'BANDHANBNK', 'TCIFINANCE', 'ICICIGI', 'HELPAGE'],
        nifty_weight: 'High'
    },
    
    // Energy & Power
    'ENERGY': {
        name: 'Energy & Power',
        index: 'NIFTY ENERGY',
        keywords: ['energy', 'power', 'renewable', 'solar', 'wind', 'electricity', 'coal', 'oil', 'gas'],
        companies: ['RELIANCE', 'NTPC', 'POWERGRID', 'ONGC', 'ADANIGREEN', 'TATAPOWER', 'ADANIPOWER', 'WAAREEENER', 'CGPOWER', 'ENRIN', 'TRITURBINE'],
        nifty_weight: 'Medium'
    },
    
    // Automobiles
    'AUTO': {
        name: 'Automobiles',
        index: 'NIFTY AUTO',
        keywords: ['auto', 'automobile', 'car', 'vehicle', 'motor', 'tyre', 'automotive'],
        companies: ['MARUTI', 'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'APOLLOTYRE', 'GABRIEL', 'FIEMIND', 'SCHAEFFLER', 'TIINDIA', 'ZFCVINDIA'],
        nifty_weight: 'Medium'
    },
    
    // Pharmaceuticals
    'PHARMA': {
        name: 'Pharmaceuticals',
        index: 'NIFTY PHARMA',
        keywords: ['pharma', 'pharmaceutical', 'drug', 'medicine', 'healthcare', 'biotech'],
        companies: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'BIOCON', 'AUROPHARMA', 'LUPIN', 'BLUEJET', 'ABBOTINDIA', 'CAPLIPOINT', 'ZYDUSWELL', 'POLYMED', 'JBCHEPHARM'],
        nifty_weight: 'Medium'
    },
    
    // Fast Moving Consumer Goods
    'FMCG': {
        name: 'Fast Moving Consumer Goods',
        index: 'NIFTY FMCG',
        keywords: ['FMCG', 'consumer', 'food', 'beverage', 'personal care', 'household'],
        companies: ['HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'MARICO', 'DABUR', 'GODREJCP', 'VBL', 'DODLA', 'FINEORG', 'GODFRYPHLP', 'JYOTHYLAB'],
        nifty_weight: 'High'
    },
    
    // Metals & Mining
    'METALS': {
        name: 'Metals & Mining',
        index: 'NIFTY METAL',
        keywords: ['metal', 'steel', 'iron', 'copper', 'aluminum', 'mining', 'ore'],
        companies: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'COALINDIA', 'NMDC', 'SAIL', 'HINDCOPPER', 'NATIONALUM', 'GRAVITA', 'APLAPOLLO', 'RRKABEL', 'VESUVIUS'],
        nifty_weight: 'Medium'
    },
    
    // Cement
    'CEMENT': {
        name: 'Cement',
        index: 'NIFTY COMMODITIES',
        keywords: ['cement', 'construction', 'building material'],
        companies: ['ULTRACEMCO', 'SHREECEM', 'GRASIM', 'ACC', 'AMBUJACEMENT', 'JKCEMENT'],
        nifty_weight: 'Low'
    },
    
    // Telecommunications
    'TELECOM': {
        name: 'Telecommunications',
        index: 'NIFTY COMMODITIES',
        keywords: ['telecom', 'telecommunication', 'mobile', 'broadband', '5G', 'tower'],
        companies: ['BHARTIARTL', 'INDUSINDBK', 'IDEA'],
        nifty_weight: 'Medium'
    },
    
    // Real Estate
    'REALTY': {
        name: 'Real Estate',
        index: 'NIFTY REALTY',
        keywords: ['real estate', 'realty', 'property', 'housing', 'developer'],
        companies: ['DLF', 'GODREJPROP', 'OBEROIRLTY', 'BRIGADE', 'PRESTIGE', 'DRL'],
        nifty_weight: 'Low'
    },
    
    // Industrial & Manufacturing
    'INDUSTRIAL': {
        name: 'Industrial & Manufacturing',
        index: 'NIFTY COMMODITIES',
        keywords: ['industrial', 'manufacturing', 'machinery', 'equipment', 'engineering'],
        companies: ['INGERRAND', 'BLUESTARCO', 'KSB', 'KIRLPNU', 'GRINDWELL', 'ACE', 'INOXINDIA', 'JWL'],
        nifty_weight: 'Medium'
    },
    
    // Defense & Aerospace
    'DEFENSE': {
        name: 'Defense & Aerospace',
        index: 'NIFTY COMMODITIES', 
        keywords: ['defense', 'aerospace', 'shipyard', 'military', 'naval'],
        companies: ['MAZDOCK'],
        nifty_weight: 'Low'
    },
    
    // Transportation & Logistics
    'TRANSPORT': {
        name: 'Transportation & Logistics',
        index: 'NIFTY COMMODITIES',
        keywords: ['transport', 'logistics', 'railway', 'shipping', 'freight'],
        companies: ['IRCTC'],
        nifty_weight: 'Low'
    },
    
    // Chemicals & Materials
    'CHEMICALS': {
        name: 'Chemicals & Materials',
        index: 'NIFTY COMMODITIES',
        keywords: ['chemical', 'specialty chemical', 'agrochemical', 'plastic'],
        companies: ['SHGANEL', 'PIIND', 'GPIL'],
        nifty_weight: 'Low'
    },
    
    // Financial Services (Non-Banking)
    'FINSERVICES': {
        name: 'Financial Services',
        index: 'NIFTY FINANCIAL SERVICES',
        keywords: ['exchange', 'commodity exchange', 'financial services'],
        companies: ['MCX', 'SFML'],
        nifty_weight: 'Low'
    },
    
    // Commodities & ETFs
    'COMMODITIES': {
        name: 'Commodities & ETFs',
        index: 'NIFTY COMMODITIES',
        keywords: ['silver', 'gold', 'commodity', 'ETF'],
        companies: ['SILVERBEES', 'EMULTIMQ', 'MAKEINDIA'],
        nifty_weight: 'Low'
    }
};

/**
 * Determine sector for a given stock symbol or name
 */
export function getSectorForStock(stockSymbol, stockName = '') {
    const symbol = stockSymbol.toUpperCase();
    const name = stockName.toLowerCase();
    
    // Direct symbol matching
    for (const [sectorCode, sectorInfo] of Object.entries(SECTOR_MAPPING)) {
        if (sectorInfo.companies.includes(symbol)) {
            return {
                code: sectorCode,
                name: sectorInfo.name,
                index: sectorInfo.index,
                nifty_weight: sectorInfo.nifty_weight
            };
        }
    }
    
    // Keyword matching in stock name (only for meaningful keywords)
    for (const [sectorCode, sectorInfo] of Object.entries(SECTOR_MAPPING)) {
        for (const keyword of sectorInfo.keywords) {
            // Skip generic words that might cause false matches
            if (keyword.length > 3 && name.includes(keyword.toLowerCase())) {
                return {
                    code: sectorCode,
                    name: sectorInfo.name,
                    index: sectorInfo.index,
                    nifty_weight: sectorInfo.nifty_weight
                };
            }
        }
    }
    
    return {
        code: 'OTHER',
        name: 'Other/Diversified',
        index: 'NIFTY 50',
        nifty_weight: 'Low'
    };
}

/**
 * Get sector-specific news keywords for enhanced sentiment analysis
 */
export function getSectorNewsKeywords(sectorCode) {
    const sectorInfo = SECTOR_MAPPING[sectorCode];
    if (!sectorInfo) return [];
    
    const baseKeywords = sectorInfo.keywords;
    const companyKeywords = sectorInfo.companies.map(c => c.toLowerCase());
    
    // Add sector-specific financial keywords
    const sectorSpecificKeywords = {
        'TECH': ['digital transformation', 'cloud', 'SaaS', 'export', 'H1B', 'automation'],
        'BANKING': ['interest rate', 'NPA', 'credit growth', 'deposit', 'RBI', 'monetary policy'],
        'ENERGY': ['crude oil', 'solar tariff', 'renewable energy', 'power demand', 'electricity'],
        'AUTO': ['EV', 'electric vehicle', 'auto sales', 'semiconductor', 'chip shortage'],
        'PHARMA': ['FDA approval', 'drug launch', 'patent', 'clinical trial', 'healthcare'],
        'FMCG': ['rural demand', 'volume growth', 'input cost', 'commodity prices'],
        'METALS': ['commodity prices', 'steel prices', 'iron ore', 'China demand'],
        'CEMENT': ['infrastructure', 'housing', 'government spending', 'construction'],
        'TELECOM': ['spectrum auction', 'ARPU', 'data consumption', '5G rollout'],
        'REALTY': ['interest rates', 'housing demand', 'land acquisition', 'RERA']
    };
    
    return [
        ...baseKeywords,
        ...companyKeywords,
        ...(sectorSpecificKeywords[sectorCode] || [])
    ];
}

/**
 * Get trailing stop suggestions based on sector volatility
 */
export function getTrailingStopSuggestions(sectorCode, analysisType = 'swing') {
    const sectorVolatility = {
        'TECH': { swing: 1.5, intraday: 0.8 },
        'BANKING': { swing: 1.2, intraday: 0.6 },
        'ENERGY': { swing: 2.0, intraday: 1.0 },
        'AUTO': { swing: 1.8, intraday: 0.9 },
        'PHARMA': { swing: 1.6, intraday: 0.8 },
        'FMCG': { swing: 1.0, intraday: 0.5 },
        'METALS': { swing: 2.2, intraday: 1.2 },
        'CEMENT': { swing: 1.4, intraday: 0.7 },
        'TELECOM': { swing: 1.3, intraday: 0.7 },
        'REALTY': { swing: 1.9, intraday: 1.0 },
        'INDUSTRIAL': { swing: 1.6, intraday: 0.8 },
        'DEFENSE': { swing: 2.1, intraday: 1.1 },
        'TRANSPORT': { swing: 1.7, intraday: 0.9 },
        'CHEMICALS': { swing: 1.8, intraday: 0.9 },
        'FINSERVICES': { swing: 1.4, intraday: 0.7 },
        'COMMODITIES': { swing: 2.3, intraday: 1.3 },
        'OTHER': { swing: 1.5, intraday: 0.8 }
    };
    
    const multiplier = sectorVolatility[sectorCode] || sectorVolatility['OTHER'];
    const baseMultiplier = multiplier[analysisType] || multiplier.swing;
    
    return {
        conservative: Math.round(baseMultiplier * 0.8 * 100) / 100,
        moderate: Math.round(baseMultiplier * 100) / 100,
        aggressive: Math.round(baseMultiplier * 1.3 * 100) / 100,
        note: `Sector-based trailing stop multipliers for ${SECTOR_MAPPING[sectorCode]?.name || 'this sector'}`
    };
}

/**
 * Get sector index correlation message
 */
export function getSectorCorrelationMessage(sectorCode) {
    const sectorInfo = SECTOR_MAPPING[sectorCode];
    if (!sectorInfo) return null;
    
    const correlationMessages = {
        'TECH': `TECH stocks often move with NIFTY IT index. Monitor US tech earnings and H1B policy changes.`,
        'BANKING': `Banking stocks track NIFTY BANK index closely. RBI policy announcements have high impact.`,
        'ENERGY': `Energy sector correlates with NIFTY ENERGY. Watch crude oil prices and renewable policy updates.`,
        'AUTO': `Auto stocks follow NIFTY AUTO. EV policies and semiconductor availability affect sentiment.`,
        'PHARMA': `Pharma stocks track NIFTY PHARMA. FDA approvals and healthcare policies drive movements.`,
        'FMCG': `FMCG stocks move with NIFTY FMCG. Rural demand and input cost inflation are key factors.`,
        'METALS': `Metal stocks correlate with NIFTY METAL. China demand and commodity cycles drive trends.`,
        'CEMENT': `Cement stocks track infrastructure spending. Government budget announcements have impact.`,
        'TELECOM': `Telecom stocks affected by spectrum auctions and data tariff changes.`,
        'REALTY': `Real estate sensitive to interest rate changes and housing policy updates.`,
        'INDUSTRIAL': `Industrial stocks correlate with manufacturing PMI and capex cycles.`,
        'DEFENSE': `Defense stocks move on government orders and geopolitical developments.`,
        'TRANSPORT': `Transportation stocks affected by fuel costs and economic activity levels.`,
        'CHEMICALS': `Chemical stocks sensitive to crude oil prices and global demand cycles.`,
        'FINSERVICES': `Financial services track market volumes and regulatory changes.`,
        'COMMODITIES': `Commodity ETFs directly track underlying commodity price movements.`
    };
    
    return correlationMessages[sectorCode] || `Monitor ${sectorInfo.index} index for sector correlation.`;
}
/**
 * Fundamental Data Service
 *
 * Fetches fundamental stock data from Screener.in:
 * - Promoter pledge percentage
 * - FII/DII holdings and changes
 * - P/E ratio and sector P/E
 * - Latest quarterly results (revenue, profit, YoY growth)
 *
 * This data feeds into Claude's weekly analysis for risk assessment.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';

// Cache TTL: 6 hours (fundamental data doesn't change frequently)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

/**
 * Fetch fundamental data for a stock from Screener.in
 * @param {string} symbol - Stock symbol (e.g., 'RELIANCE', 'TCS')
 * @returns {Promise<Object>} Fundamental data
 */
async function fetchFundamentalData(symbol) {
  const cacheKey = symbol.toUpperCase();

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[FUNDAMENTAL] Cache hit for ${symbol}`);
    return cached.data;
  }

  const requestId = uuidv4().substring(0, 8);
  console.log(`[FUNDAMENTAL] [${requestId}] Fetching data for ${symbol}...`);

  try {
    const url = `https://www.screener.in/company/${symbol}/consolidated/`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // Parse the data
    const data = {
      symbol: symbol.toUpperCase(),
      fetchedAt: new Date().toISOString(),

      // Valuation
      pe: extractPE($),
      sectorPE: extractSectorPE($),
      pbRatio: extractPBRatio($),
      marketCap: extractMarketCap($),

      // Shareholding pattern
      shareholding: extractShareholding($),

      // Quarterly results
      quarterlyResults: extractQuarterlyResults($),

      // Annual results (for YoY comparison)
      annualResults: extractAnnualResults($),

      // Pledging data
      promoterPledge: extractPromoterPledge($),

      // Key ratios
      roce: extractROCE($),
      roe: extractROE($),
      debtToEquity: extractDebtToEquity($)
    };

    // Cache the result
    cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    console.log(`[FUNDAMENTAL] [${requestId}] ✅ Data fetched for ${symbol}: PE=${data.pe}, Promoter Pledge=${data.promoterPledge?.pledgePercent || 0}%`);

    return data;

  } catch (error) {
    // Try standalone URL if consolidated fails
    if (error.response?.status === 404) {
      return await fetchFundamentalDataStandalone(symbol);
    }

    console.error(`[FUNDAMENTAL] [${requestId}] ❌ Failed for ${symbol}:`, error.message);

    // Return empty data structure on error
    return {
      symbol: symbol.toUpperCase(),
      fetchedAt: new Date().toISOString(),
      error: error.message,
      pe: null,
      sectorPE: null,
      shareholding: null,
      quarterlyResults: null,
      promoterPledge: null
    };
  }
}

/**
 * Fallback: Fetch from standalone URL (for companies without consolidated financials)
 */
async function fetchFundamentalDataStandalone(symbol) {
  const requestId = uuidv4().substring(0, 8);
  console.log(`[FUNDAMENTAL] [${requestId}] Trying standalone URL for ${symbol}...`);

  try {
    const url = `https://www.screener.in/company/${symbol}/`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    const data = {
      symbol: symbol.toUpperCase(),
      fetchedAt: new Date().toISOString(),
      pe: extractPE($),
      sectorPE: extractSectorPE($),
      pbRatio: extractPBRatio($),
      marketCap: extractMarketCap($),
      shareholding: extractShareholding($),
      quarterlyResults: extractQuarterlyResults($),
      annualResults: extractAnnualResults($),
      promoterPledge: extractPromoterPledge($),
      roce: extractROCE($),
      roe: extractROE($),
      debtToEquity: extractDebtToEquity($)
    };

    // Cache standalone result too
    cache.set(symbol.toUpperCase(), {
      data,
      timestamp: Date.now()
    });

    return data;

  } catch (error) {
    console.error(`[FUNDAMENTAL] [${requestId}] ❌ Standalone also failed for ${symbol}:`, error.message);
    return {
      symbol: symbol.toUpperCase(),
      fetchedAt: new Date().toISOString(),
      error: error.message,
      pe: null,
      sectorPE: null,
      shareholding: null,
      quarterlyResults: null,
      promoterPledge: null
    };
  }
}

/**
 * Extract P/E ratio from page
 */
function extractPE($) {
  try {
    // Look for Stock P/E in ratios section
    const peText = $('li:contains("Stock P/E")').find('.number').first().text().trim();
    const pe = parseFloat(peText);
    return isNaN(pe) ? null : pe;
  } catch {
    return null;
  }
}

/**
 * Extract Sector P/E (from median PE comparison)
 */
function extractSectorPE($) {
  try {
    // Look for Industry PE or Median PE
    const sectorPEText = $('li:contains("Industry PE")').find('.number').first().text().trim() ||
                         $('li:contains("Sector PE")').find('.number').first().text().trim();
    const sectorPE = parseFloat(sectorPEText);
    return isNaN(sectorPE) ? null : sectorPE;
  } catch {
    return null;
  }
}

/**
 * Extract P/B ratio
 */
function extractPBRatio($) {
  try {
    const pbText = $('li:contains("Price to book")').find('.number').first().text().trim();
    const pb = parseFloat(pbText);
    return isNaN(pb) ? null : pb;
  } catch {
    return null;
  }
}

/**
 * Extract Market Cap
 */
function extractMarketCap($) {
  try {
    const mcText = $('li:contains("Market Cap")').find('.number').first().text().trim();
    // Parse values like "₹ 19,50,000 Cr." -> 1950000
    const cleaned = mcText.replace(/[₹,\s]/g, '').replace('Cr.', '').replace('Cr', '');
    const mc = parseFloat(cleaned);
    return isNaN(mc) ? null : mc;
  } catch {
    return null;
  }
}

/**
 * Extract shareholding pattern (promoter, FII, DII holdings)
 */
function extractShareholding($) {
  try {
    const shareholding = {
      promoter: null,
      promoterChange: null,
      fii: null,
      fiiChange: null,
      dii: null,
      diiChange: null,
      public: null,
      asOfQuarter: null
    };

    // Find the shareholding table
    const shareholdingSection = $('section#shareholding, section:contains("Shareholding Pattern")').first();

    if (shareholdingSection.length === 0) {
      // Try alternate structure
      const table = $('table:contains("Promoters")');
      if (table.length > 0) {
        return extractShareholdingFromTable($, table);
      }
      return shareholding;
    }

    // Extract from table rows
    shareholdingSection.find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().toLowerCase();
        const values = [];

        cells.each((i, cell) => {
          if (i > 0) {
            const val = parseFloat($(cell).text().replace('%', '').trim());
            if (!isNaN(val)) values.push(val);
          }
        });

        if (values.length >= 1) {
          const current = values[values.length - 1];
          const previous = values.length >= 2 ? values[values.length - 2] : null;
          const change = previous !== null ? parseFloat((current - previous).toFixed(2)) : null;

          if (label.includes('promoter') && !label.includes('pledge')) {
            shareholding.promoter = current;
            shareholding.promoterChange = change;
          } else if (label.includes('fii') || label.includes('foreign')) {
            shareholding.fii = current;
            shareholding.fiiChange = change;
          } else if (label.includes('dii') || label.includes('domestic')) {
            shareholding.dii = current;
            shareholding.diiChange = change;
          } else if (label.includes('public')) {
            shareholding.public = current;
          }
        }
      }
    });

    // Extract quarter info from header
    const headers = shareholdingSection.find('th');
    if (headers.length > 1) {
      shareholding.asOfQuarter = $(headers[headers.length - 1]).text().trim();
    }

    return shareholding;

  } catch (error) {
    console.error('[FUNDAMENTAL] Error extracting shareholding:', error.message);
    return null;
  }
}

/**
 * Alternative shareholding extraction from table
 */
function extractShareholdingFromTable($, table) {
  const shareholding = {
    promoter: null,
    promoterChange: null,
    fii: null,
    fiiChange: null,
    dii: null,
    diiChange: null,
    public: null,
    asOfQuarter: null
  };

  table.find('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim().toLowerCase();
      const lastCell = $(cells[cells.length - 1]).text().replace('%', '').trim();
      const value = parseFloat(lastCell);

      if (!isNaN(value)) {
        if (label.includes('promoter') && !label.includes('pledge')) {
          shareholding.promoter = value;
        } else if (label.includes('fii') || label.includes('foreign')) {
          shareholding.fii = value;
        } else if (label.includes('dii') || label.includes('domestic')) {
          shareholding.dii = value;
        } else if (label.includes('public')) {
          shareholding.public = value;
        }
      }
    }
  });

  return shareholding;
}

/**
 * Extract quarterly results (last 2 quarters for comparison)
 */
function extractQuarterlyResults($) {
  try {
    const results = {
      latestQuarter: null,
      previousQuarter: null,
      yoyGrowth: null
    };

    // Find quarterly results table
    const quarterlySection = $('section#quarters, section:contains("Quarterly Results")').first();

    if (quarterlySection.length === 0) {
      return results;
    }

    // Get header to find quarter names
    const headers = quarterlySection.find('th');
    const quarterNames = [];
    headers.each((i, th) => {
      if (i > 0) quarterNames.push($(th).text().trim());
    });

    // Extract revenue and profit
    let revenue = [];
    let profit = [];

    quarterlySection.find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().toLowerCase();

        if (label.includes('sales') || label.includes('revenue')) {
          cells.each((i, cell) => {
            if (i > 0) {
              const val = parseFloat($(cell).text().replace(/,/g, '').trim());
              if (!isNaN(val)) revenue.push(val);
            }
          });
        } else if (label.includes('net profit') || label === 'profit') {
          cells.each((i, cell) => {
            if (i > 0) {
              const val = parseFloat($(cell).text().replace(/,/g, '').trim());
              if (!isNaN(val)) profit.push(val);
            }
          });
        }
      }
    });

    // Latest quarter (first column after label)
    if (revenue.length >= 1 && profit.length >= 1) {
      results.latestQuarter = {
        name: quarterNames[0] || 'Latest',
        revenue: revenue[0],
        profit: profit[0]
      };
    }

    // Previous quarter (second column)
    if (revenue.length >= 2 && profit.length >= 2) {
      results.previousQuarter = {
        name: quarterNames[1] || 'Previous',
        revenue: revenue[1],
        profit: profit[1]
      };
    }

    // YoY growth (compare with 4 quarters ago if available)
    if (revenue.length >= 5 && profit.length >= 5) {
      const revenueYoY = ((revenue[0] - revenue[4]) / Math.abs(revenue[4])) * 100;
      const profitYoY = ((profit[0] - profit[4]) / Math.abs(profit[4])) * 100;

      results.yoyGrowth = {
        revenueGrowth: parseFloat(revenueYoY.toFixed(1)),
        profitGrowth: parseFloat(profitYoY.toFixed(1))
      };
    }

    return results;

  } catch (error) {
    console.error('[FUNDAMENTAL] Error extracting quarterly results:', error.message);
    return null;
  }
}

/**
 * Extract annual results
 */
function extractAnnualResults($) {
  try {
    const results = {
      latestYear: null,
      previousYear: null,
      yoyGrowth: null
    };

    // Find profit & loss section
    const annualSection = $('section#profit-loss, section:contains("Profit & Loss")').first();

    if (annualSection.length === 0) {
      return results;
    }

    // Extract revenue and profit (last 2 years)
    let revenue = [];
    let profit = [];

    annualSection.find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().toLowerCase();

        if (label.includes('sales') || label.includes('revenue')) {
          cells.each((i, cell) => {
            if (i > 0) {
              const val = parseFloat($(cell).text().replace(/,/g, '').trim());
              if (!isNaN(val)) revenue.push(val);
            }
          });
        } else if (label.includes('net profit') || label === 'profit') {
          cells.each((i, cell) => {
            if (i > 0) {
              const val = parseFloat($(cell).text().replace(/,/g, '').trim());
              if (!isNaN(val)) profit.push(val);
            }
          });
        }
      }
    });

    // Get most recent values (first columns — Screener.in shows newest year on left)
    if (revenue.length >= 1 && profit.length >= 1) {
      results.latestYear = {
        revenue: revenue[0],
        profit: profit[0]
      };
    }

    if (revenue.length >= 2 && profit.length >= 2) {
      results.previousYear = {
        revenue: revenue[1],
        profit: profit[1]
      };

      // Calculate YoY growth
      const revenueYoY = ((results.latestYear.revenue - results.previousYear.revenue) / Math.abs(results.previousYear.revenue)) * 100;
      const profitYoY = ((results.latestYear.profit - results.previousYear.profit) / Math.abs(results.previousYear.profit)) * 100;

      results.yoyGrowth = {
        revenueGrowth: parseFloat(revenueYoY.toFixed(1)),
        profitGrowth: parseFloat(profitYoY.toFixed(1))
      };
    }

    return results;

  } catch (error) {
    console.error('[FUNDAMENTAL] Error extracting annual results:', error.message);
    return null;
  }
}

/**
 * Extract promoter pledge percentage
 */
function extractPromoterPledge($) {
  try {
    const pledge = {
      pledgePercent: 0,
      pledgeChange: null,
      pledgedShares: null,
      asOfQuarter: null
    };

    // Look for pledge in shareholding section
    const shareholdingSection = $('section#shareholding, section:contains("Shareholding Pattern")').first();

    shareholdingSection.find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().toLowerCase();

        if (label.includes('pledge')) {
          const values = [];
          cells.each((i, cell) => {
            if (i > 0) {
              const val = parseFloat($(cell).text().replace('%', '').trim());
              if (!isNaN(val)) values.push(val);
            }
          });

          if (values.length >= 1) {
            pledge.pledgePercent = values[values.length - 1];
            if (values.length >= 2) {
              pledge.pledgeChange = parseFloat((values[values.length - 1] - values[values.length - 2]).toFixed(2));
            }
          }
        }
      }
    });

    // Also check for text pattern "X% of promoter holding pledged"
    const pageText = $('body').text();
    const pledgeMatch = pageText.match(/(\d+\.?\d*)\s*%\s*(?:of\s+)?promoter\s+(?:holding\s+)?pledged/i);
    if (pledgeMatch && pledge.pledgePercent === 0) {
      pledge.pledgePercent = parseFloat(pledgeMatch[1]);
    }

    return pledge;

  } catch (error) {
    console.error('[FUNDAMENTAL] Error extracting pledge:', error.message);
    return null;
  }
}

/**
 * Extract ROCE (Return on Capital Employed)
 */
function extractROCE($) {
  try {
    const roceText = $('li:contains("ROCE")').find('.number').first().text().trim();
    const roce = parseFloat(roceText.replace('%', ''));
    return isNaN(roce) ? null : roce;
  } catch {
    return null;
  }
}

/**
 * Extract ROE (Return on Equity)
 */
function extractROE($) {
  try {
    const roeText = $('li:contains("ROE")').find('.number').first().text().trim();
    const roe = parseFloat(roeText.replace('%', ''));
    return isNaN(roe) ? null : roe;
  } catch {
    return null;
  }
}

/**
 * Extract Debt to Equity ratio
 */
function extractDebtToEquity($) {
  try {
    const deText = $('li:contains("Debt to equity")').find('.number').first().text().trim();
    const de = parseFloat(deText);
    return isNaN(de) ? null : de;
  } catch {
    return null;
  }
}

/**
 * Fetch fundamental data for multiple stocks in parallel
 * @param {string[]} symbols - Array of stock symbols
 * @param {number} concurrency - Max parallel requests (default: 3)
 * @returns {Promise<Map<string, Object>>} Map of symbol -> fundamental data
 */
async function fetchMultipleFundamentals(symbols, concurrency = 3) {
  const results = new Map();

  // Process in batches to avoid overwhelming Screener.in
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(symbol => fetchFundamentalData(symbol))
    );

    batch.forEach((symbol, index) => {
      results.set(symbol.toUpperCase(), batchResults[index]);
    });

    // Delay between batches to be respectful
    if (i + concurrency < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return results;
}

/**
 * Clear the cache (useful for testing or forced refresh)
 */
function clearCache() {
  cache.clear();
  console.log('[FUNDAMENTAL] Cache cleared');
}

/**
 * Format fundamental data for Claude prompt
 * @param {Object} data - Fundamental data from fetchFundamentalData
 * @returns {string} Formatted text for prompt
 */
function formatForPrompt(data) {
  if (!data || data.error) {
    return `Fundamental data unavailable: ${data?.error || 'No data'}`;
  }

  const lines = [];

  // Valuation
  if (data.pe !== null) {
    const peVsSector = data.sectorPE ? ` (Sector PE: ${data.sectorPE})` : '';
    lines.push(`P/E: ${data.pe}${peVsSector}`);
  }

  if (data.marketCap !== null) {
    lines.push(`Market Cap: ₹${data.marketCap.toLocaleString('en-IN')} Cr`);
  }

  // Shareholding
  if (data.shareholding) {
    const sh = data.shareholding;
    const parts = [];

    if (sh.promoter !== null) {
      const change = sh.promoterChange !== null && sh.promoterChange !== 0
        ? ` (${sh.promoterChange > 0 ? '+' : ''}${sh.promoterChange}%)`
        : '';
      parts.push(`Promoter: ${sh.promoter}%${change}`);
    }

    if (sh.fii !== null) {
      const change = sh.fiiChange !== null && sh.fiiChange !== 0
        ? ` (${sh.fiiChange > 0 ? '+' : ''}${sh.fiiChange}%)`
        : '';
      parts.push(`FII: ${sh.fii}%${change}`);
    }

    if (sh.dii !== null) {
      const change = sh.diiChange !== null && sh.diiChange !== 0
        ? ` (${sh.diiChange > 0 ? '+' : ''}${sh.diiChange}%)`
        : '';
      parts.push(`DII: ${sh.dii}%${change}`);
    }

    if (parts.length > 0) {
      lines.push(`Shareholding: ${parts.join(', ')}`);
    }
  }

  // Pledge
  if (data.promoterPledge && data.promoterPledge.pledgePercent > 0) {
    const change = data.promoterPledge.pledgeChange !== null && data.promoterPledge.pledgeChange !== 0
      ? ` (${data.promoterPledge.pledgeChange > 0 ? '+' : ''}${data.promoterPledge.pledgeChange}%)`
      : '';
    lines.push(`⚠️ Promoter Pledge (% of promoter shares pledged as collateral): ${data.promoterPledge.pledgePercent}%${change}`);
  }

  // Quarterly results
  if (data.quarterlyResults?.latestQuarter) {
    const q = data.quarterlyResults.latestQuarter;
    lines.push(`Latest Quarter (${q.name}): Revenue ₹${q.revenue?.toLocaleString('en-IN') || 'N/A'} Cr, Profit ₹${q.profit?.toLocaleString('en-IN') || 'N/A'} Cr`);

    if (data.quarterlyResults.yoyGrowth) {
      const yoy = data.quarterlyResults.yoyGrowth;
      lines.push(`YoY Growth: Revenue ${yoy.revenueGrowth > 0 ? '+' : ''}${yoy.revenueGrowth}%, Profit ${yoy.profitGrowth > 0 ? '+' : ''}${yoy.profitGrowth}%`);
    }
  }

  // Key ratios
  const ratios = [];
  if (data.roce !== null) ratios.push(`ROCE: ${data.roce}%`);
  if (data.roe !== null) ratios.push(`ROE: ${data.roe}%`);
  if (data.debtToEquity !== null) ratios.push(`D/E: ${data.debtToEquity}`);
  if (ratios.length > 0) {
    lines.push(ratios.join(', '));
  }

  return lines.join('\n');
}

export default {
  fetchFundamentalData,
  fetchMultipleFundamentals,
  formatForPrompt,
  clearCache
};

export {
  fetchFundamentalData,
  fetchMultipleFundamentals,
  formatForPrompt,
  clearCache
};

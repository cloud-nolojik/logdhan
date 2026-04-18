/**
 * Regime entry point — wraps data fetchers + scoring into one call.
 * Imported by dailyPicksService.js Step 1.
 */

import { fetchAllRegimeInputs } from './regimeDataFetchers.js';
import { buildMarketContext } from './regimeScoring.js';

export async function computeMarketContextV2() {
  const data = await fetchAllRegimeInputs();
  return buildMarketContext(data);
}

export default { computeMarketContextV2 };

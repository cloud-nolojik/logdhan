/**
 * Event Blackout Calendar
 *
 * Returns a list of high-event dates on which the system should refuse to
 * trade regardless of what the regime says. These are days where the normal
 * statistical priors fail: union budget, RBI MPC decisions, quarterly GDP,
 * major election results, US Fed decisions during market hours.
 *
 * Data source: a static map maintained in this file. Not fetched from any
 * external calendar — the event list is small, slow-moving, and any external
 * dependency here would be a new point of failure on a load-bearing path.
 *
 * Update yearly. One commit in this file can pause the system for a day.
 */

// Format: 'YYYY-MM-DD' IST → short reason. Add entries as the calendar fills in.
// Keep this file small and stable — it's a blocklist, not a database.
const BLACKOUT_DATES = {
  // 2026 — examples, update with actual confirmed dates
  '2026-02-01': 'union_budget_2026',
  '2026-04-09': 'rbi_mpc_april',
  '2026-06-06': 'rbi_mpc_june',
  '2026-08-06': 'rbi_mpc_august',
  '2026-10-01': 'rbi_mpc_october',
  '2026-12-05': 'rbi_mpc_december',
  // Add results days, GDP releases, etc. here as they're confirmed.
};

/**
 * Returns { blocked: true, reason } on blackout dates, else { blocked: false }.
 *
 * @param {Date} [date] - defaults to now
 */
export function checkEventBlackout(date = new Date()) {
  const istMs = date.getTime() + (5.5 * 60 * 60 * 1000);
  const istDate = new Date(istMs).toISOString().slice(0, 10);
  const reason = BLACKOUT_DATES[istDate];
  if (reason) {
    return { blocked: true, reason, date: istDate };
  }
  return { blocked: false, date: istDate };
}

export function listBlackoutDates() {
  return Object.entries(BLACKOUT_DATES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, reason]) => ({ date, reason }));
}

export default { checkEventBlackout, listBlackoutDates };

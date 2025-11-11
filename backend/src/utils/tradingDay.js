const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // 5 hours 30 minutes in milliseconds

/**
 * Returns the UTC boundaries for the current trading day in IST (Asia/Kolkata).
 * @param {Date} referenceDate - A reference point in time (defaults to now).
 * @returns {{startUtc: Date, endUtc: Date}} - Start (inclusive) and end (exclusive) of the IST day in UTC.
 */
export function getIstDayRange(referenceDate = new Date()) {
    const referenceMs = referenceDate.getTime();
    const istMs = referenceMs + IST_OFFSET_MS;
    const istDate = new Date(istMs);

    const year = istDate.getUTCFullYear();
    const month = istDate.getUTCMonth();
    const day = istDate.getUTCDate();

    const startOfDayUtcMs = Date.UTC(year, month, day, 0, 0, 0) - IST_OFFSET_MS;
    const endOfDayUtcMs = startOfDayUtcMs + 24 * 60 * 60 * 1000;

    return {
        startUtc: new Date(startOfDayUtcMs),
        endUtc: new Date(endOfDayUtcMs)
    };
}

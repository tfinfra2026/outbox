// Shared datetime formatting for anything written into a DATETIME column.
//
// JS's Date#toISOString() produces '2026-07-23T12:20:00.046Z' - the 'T', the
// 'Z' and the milliseconds all make MySQL's DATETIME parser reject the value
// outright ("Incorrect datetime value"). SQLite stores dates as plain TEXT so
// it doesn't care what format we use, as long as it's consistent and still
// sorts correctly. 'YYYY-MM-DD HH:MM:SS' (UTC) satisfies both drivers.
function toSqlDatetime(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Converts a "wall clock" datetime-local input value (e.g. "2026-07-25T14:30", with no
// timezone info - exactly what a browser's <input type="datetime-local"> sends) into the
// real UTC instant it represents in the given IANA timezone (APP_TIMEZONE), without pulling
// in a timezone library. Standard trick: format a guess through Intl for that zone, measure
// how far off the guess landed, and correct by that amount.
function zonedTimeToUtc(localDatetimeStr, timeZone) {
  const [datePart, timePart] = localDatetimeStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = (timePart || '00:00').split(':').map(Number);
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = fmt.formatToParts(new Date(guessUtcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asIfUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = asIfUtcMs - guessUtcMs;

  return new Date(guessUtcMs - offsetMs);
}

module.exports = { toSqlDatetime, zonedTimeToUtc };

// Computes a mailbox's safe sending cap for a given date, based on its warmup ramp.
// Day 0 of warmup = warmup_start_cap. Cap increases linearly each day until it
// reaches daily_cap on warmup_ramp_days, then stays at daily_cap.
function daysSince(dateStr) {
  const start = new Date(dateStr + 'T00:00:00Z');
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.max(0, Math.round((today - start) / 86400000));
}

// Same ramp math as daysSince, but for an arbitrary date instead of always "today" - lets the
// completion-estimate projection (scheduler.js's projectCampaignCompletion) simulate a
// mailbox's capacity on a future date, day by day, instead of only ever reading "right now".
function daysBetween(startDateStr, asOfDate) {
  const start = new Date(startDateStr + 'T00:00:00Z');
  const asOf = new Date(asOfDate.toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.max(0, Math.round((asOf - start) / 86400000));
}

// The actual ramp formula, parameterized by date - safeCapForToday below is just this called
// with today's date, kept as its own function so every existing caller is unaffected.
function capOnDate(mailbox, asOfDate) {
  const elapsed = daysBetween(mailbox.warmup_start_date, asOfDate);
  const rampDays = mailbox.warmup_ramp_days || 21;
  const startCap = mailbox.warmup_start_cap || 5;
  const finalCap = mailbox.daily_cap || 30;

  if (mailbox.status === 'paused') return 0;
  if (elapsed >= rampDays) return finalCap;

  const progress = elapsed / rampDays;
  const cap = Math.round(startCap + (finalCap - startCap) * progress);
  return Math.max(startCap, Math.min(cap, finalCap));
}

function safeCapForToday(mailbox) {
  return capOnDate(mailbox, new Date());
}

function warmupStatus(mailbox) {
  const elapsed = daysSince(mailbox.warmup_start_date);
  const rampDays = mailbox.warmup_ramp_days || 21;
  if (mailbox.status === 'paused') return 'paused';
  if (elapsed >= rampDays) return 'active';
  return 'warming';
}

module.exports = { safeCapForToday, capOnDate, warmupStatus, daysSince };

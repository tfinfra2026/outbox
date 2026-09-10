// The core sending engine. runOnce() is called on a cron interval (see server.js) and also
// exposed for on-demand smoke testing. It enforces every safety rule discussed in planning:
// warmup ramp, per-mailbox daily cap, minimum gap between emails to the same prospect,
// business-hours/weekday sending window, randomized delay between sends, suppression checks,
// engagement-aware follow-up skipping, and mailbox auto-pause on high bounce/complaint rate.
const { Campaigns, Mailboxes, Templates, Sends, CampaignProspects, Suppression, Settings, AuditLog, ActivityLog } = require('../db/repo');
const { safeCapForToday, capOnDate } = require('./warmup');
const { sendTemplateToProspect, makeToken } = require('./mailer');
const { toSqlDatetime, zonedTimeToUtc } = require('./dates');

// A step's total wait before becoming due - wait_days plus an optional wait_hours/wait_minutes,
// so a step can wait a partial day (e.g. "3 hours, 30 minutes later") rather than only whole-day
// gaps.
function stepWaitMs(step) {
  return (step.wait_days || 0) * 86400000 + (step.wait_hours || 0) * 3600000 + (step.wait_minutes || 0) * 60000;
}

// `settings` here is the DB-backed settings-table snapshot (Settings.all()) - these guardrails
// used to live only in .env; they're now editable at runtime from Settings in the UI, so every
// function that used to read process.env directly now checks settings first, falling back to
// .env and then a hardcoded default for a totally fresh install with nothing seeded yet.
function isWithinSendWindow(settings = {}, now = new Date()) {
  const tz = process.env.APP_TIMEZONE || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const weekday = parts.find((p) => p.type === 'weekday').value; // e.g. "Mon"
  const startHour = Number(settings.send_window_start_hour ?? process.env.SEND_WINDOW_START_HOUR ?? 9);
  const endHour = Number(settings.send_window_end_hour ?? process.env.SEND_WINDOW_END_HOUR ?? 18);
  const weekdaysOnlySetting = settings.send_only_weekdays ?? process.env.SEND_ONLY_WEEKDAYS;
  const weekdaysOnly = weekdaysOnlySetting !== 'false';
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (weekdaysOnly && isWeekend) return false;
  return hour >= startHour && hour < endHour;
}

// Picking a schedule date/time (or clicking "send now") doesn't itself guarantee sending
// starts then - it's still subject to the send-window/weekday guardrails above. Rather than
// let a user discover that gap after the fact (as happened: scheduled for 10:37 PM against a
// 9-8pm weekday-only window, so nothing happened until the window reopened), this estimates
// the actual next moment sending could begin for a given candidate instant, so the UI can show
// it up front. Approximate by design (snaps to the window's opening hour, doesn't account for
// per-minute mailbox capacity) - good enough to set honest expectations, not a sending guarantee.
function estimateEffectiveStart(candidateDate, settings = {}) {
  const tz = process.env.APP_TIMEZONE || 'UTC';
  const startHour = Number(settings.send_window_start_hour ?? process.env.SEND_WINDOW_START_HOUR ?? 9);
  const endHour = Number(settings.send_window_end_hour ?? process.env.SEND_WINDOW_END_HOUR ?? 18);
  const weekdaysOnlySetting = settings.send_only_weekdays ?? process.env.SEND_ONLY_WEEKDAYS;
  const weekdaysOnly = weekdaysOnlySetting !== 'false';

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
  });
  const get = (parts, type) => parts.find((p) => p.type === type).value;

  const candidateParts = fmt.formatToParts(candidateDate);
  const candidateHour = Number(get(candidateParts, 'hour'));
  const candidateWeekday = get(candidateParts, 'weekday');
  const candidateIsWeekend = candidateWeekday === 'Sat' || candidateWeekday === 'Sun';

  // Already a valid sending moment as picked - no adjustment needed.
  if ((!weekdaysOnly || !candidateIsWeekend) && candidateHour >= startHour && candidateHour < endHour) {
    return candidateDate;
  }

  // Otherwise scan forward day by day (2 week safety bound) for the next allowed day, and
  // snap to that day's window-opening hour.
  for (let i = 0; i < 14; i++) {
    const dayCursor = new Date(candidateDate.getTime() + i * 86400000);
    const dayParts = fmt.formatToParts(dayCursor);
    const dWeekday = get(dayParts, 'weekday');
    if (weekdaysOnly && (dWeekday === 'Sat' || dWeekday === 'Sun')) continue;
    if (i === 0 && Number(get(dayParts, 'hour')) >= endHour) continue; // today's window already closed

    const y = get(dayParts, 'year');
    const mo = get(dayParts, 'month');
    const d = get(dayParts, 'day');
    return zonedTimeToUtc(`${y}-${mo}-${d}T${String(startHour).padStart(2, '0')}:00`, tz);
  }
  return null;
}

// Projects roughly how long an entire campaign will take to get its prospects through the
// sequence, given today's real mailbox capacity (including anyone still on the warmup ramp)
// and the send-window/weekday guardrails - shown in the Schedule/Send-now confirm popup so the
// person scheduling sees the real cost, not just when the first email goes out.
//
// Deliberately approximate, same philosophy as estimateEffectiveStart above: it simulates raw
// daily capacity vs. total sends needed (prospects x steps), not a full per-prospect wait-day
// simulation. With any real-sized prospect list, the mailbox daily caps are almost always the
// actual bottleneck (see the analysis that prompted this feature - pacing delay tops out around
// 350 sends/day even at its slowest, far above what a couple of mailboxes' caps allow), so a
// capacity projection gives an honest, useful estimate without needing to model every
// prospect's individual step timer.
//
// `alreadyCompletedSteps` (default 0, matching every existing caller - the pre-launch estimate
// popup, which always projects a campaign that hasn't sent anything yet) lets this exact same
// projection double as "how much longer from here" for a campaign that's already mid-flight:
// pass the sequence-wide current_step_sum (steps already sent, summed across everyone still in
// the funnel - the same figure the Sequence progress bar already uses) and the full-sequence
// target shrinks to just what's actually still owed, instead of restarting the count from zero.
function projectCampaignCompletion({ startDate, mailboxes, prospectsCount, stepCount, settings = {}, alreadyCompletedSteps = 0 }) {
  const weekdaysOnlySetting = settings.send_only_weekdays ?? process.env.SEND_ONLY_WEEKDAYS;
  const weekdaysOnly = weekdaysOnlySetting !== 'false';
  const tz = process.env.APP_TIMEZONE || 'UTC';

  const activeMailboxes = mailboxes.filter((m) => m.status !== 'paused');
  const combinedCapacityToday = activeMailboxes.reduce((sum, m) => sum + capOnDate(m, new Date()), 0);

  if (prospectsCount <= 0 || stepCount <= 0 || activeMailboxes.length === 0) {
    return { combined_daily_capacity_today: combinedCapacityToday, step1_complete_at: null, full_sequence_complete_at: null };
  }

  const step1Target = prospectsCount;
  const fullTarget = Math.max(prospectsCount * stepCount - alreadyCompletedSteps, 0);
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const get = (parts, type) => parts.find((p) => p.type === type).value;

  // Nothing left owed - already fully sent (current_step_sum caught up to the full target).
  // Reported as "done today" rather than null, so a caller can't mistake this for "unknown".
  if (fullTarget <= 0) {
    const parts = dayFmt.formatToParts(startDate);
    const todayStr = `${get(parts, 'year')}-${get(parts, 'month')}-${get(parts, 'day')}`;
    return { combined_daily_capacity_today: combinedCapacityToday, step1_complete_at: todayStr, full_sequence_complete_at: todayStr };
  }

  let cumulative = 0;
  let step1CompleteAt = null;
  let fullCompleteAt = null;
  const SAFETY_DAYS = 3650; // ~10 years - stops the loop if capacity is somehow always 0 (e.g. every mailbox paused mid-way)

  for (let i = 0; i < SAFETY_DAYS && !fullCompleteAt; i++) {
    const dayCursor = new Date(startDate.getTime() + i * 86400000);
    const parts = dayFmt.formatToParts(dayCursor);
    const weekday = get(parts, 'weekday');
    if (weekdaysOnly && (weekday === 'Sat' || weekday === 'Sun')) continue;

    cumulative += activeMailboxes.reduce((sum, m) => sum + capOnDate(m, dayCursor), 0);

    if (!step1CompleteAt && cumulative >= step1Target) step1CompleteAt = `${get(parts, 'year')}-${get(parts, 'month')}-${get(parts, 'day')}`;
    if (!fullCompleteAt && cumulative >= fullTarget) fullCompleteAt = `${get(parts, 'year')}-${get(parts, 'month')}-${get(parts, 'day')}`;
  }

  return { combined_daily_capacity_today: combinedCapacityToday, step1_complete_at: step1CompleteAt, full_sequence_complete_at: fullCompleteAt };
}

// Pacing between sends: each campaign can override the global default (set on the
// Campaign detail page), e.g. a fast-testing campaign at 10-20s vs. the normal 45-180s.
// Falls back to the Settings/.env range for any campaign that hasn't set its own.
function randomDelayMs(cp, settings = {}) {
  const min = Number(cp?.min_seconds_between_sends ?? settings.min_seconds_between_sends ?? process.env.MIN_SECONDS_BETWEEN_SENDS ?? 45);
  const max = Number(cp?.max_seconds_between_sends ?? settings.max_seconds_between_sends ?? process.env.MAX_SECONDS_BETWEEN_SENDS ?? 180);
  if (max <= min) return min * 1000;
  return (min + Math.random() * (max - min)) * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickMailboxWithCapacity(campaignId) {
  const mailboxes = await Campaigns.listMailboxes(campaignId);
  const candidates = [];
  for (let mb of mailboxes) {
    mb = await Mailboxes.resetDailyCounterIfNeeded(mb);
    if (mb.status === 'paused') continue;
    const cap = safeCapForToday(mb);
    if (mb.sent_today < cap) candidates.push({ mb, remaining: cap - mb.sent_today });
  }
  if (candidates.length === 0) return null;
  // Prefer the mailbox with the most remaining headroom today (spreads load evenly).
  candidates.sort((a, b) => b.remaining - a.remaining);
  return candidates[0].mb;
}

async function enforceGlobalMinimumGap(email, settings = {}) {
  // Minimum hours before this prospect can receive ANY email again, across all campaigns.
  const minHours = Number(settings.min_hours_between_emails_to_same_prospect ?? process.env.MIN_HOURS_BETWEEN_EMAILS_TO_SAME_PROSPECT ?? 72);
  const db = require('../db/index');
  const rows = await db.query(
    `SELECT s.sent_at FROM sends s
     INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
     INNER JOIN prospects p ON p.id = cp.prospect_id
     WHERE p.email = ? AND s.sent_at IS NOT NULL ORDER BY s.sent_at DESC LIMIT 1`,
    [email]
  );
  if (rows.length === 0) return true;
  const last = new Date(rows[0].sent_at);
  const hoursSince = (Date.now() - last.getTime()) / 3600000;
  return hoursSince >= minHours;
}

// DISABLED by request - kept here (unused, no longer called from runOnceInner below) rather than
// deleted, in case mailbox-level pausing is wanted back later. Two of the four Auto-pause
// threshold fields ("Pause if bounce rate exceeds" / "Pause if spam complaints exceed") were
// removed from Settings at the same time (see GUARDRAIL_FIELDS in frontend/src/pages/Settings.jsx)
// - only "Pause a campaign if its own bounce rate exceeds" (evaluateCampaignBounceHealth below)
// is still active. Their settings-table rows are left alone, just unread now.
async function autoPauseUnhealthyMailboxes(settings = {}) {
  const bounceThreshold = Number(settings.auto_pause_bounce_rate_percent ?? process.env.AUTO_PAUSE_BOUNCE_RATE_PERCENT ?? 5);
  const complaintThreshold = Number(settings.auto_pause_complaint_rate_percent ?? process.env.AUTO_PAUSE_COMPLAINT_RATE_PERCENT ?? 0.3);
  const mailboxes = await Mailboxes.list();
  for (const mb of mailboxes) {
    if (mb.status === 'paused' || mb.total_sent_30d < 20) continue; // need a minimum sample size
    const bounceRate = (mb.bounce_count_30d / mb.total_sent_30d) * 100;
    const complaintRate = (mb.complaint_count_30d / mb.total_sent_30d) * 100;
    if (bounceRate > bounceThreshold || complaintRate > complaintThreshold) {
      // Bounce is checked first, so if both happen to be over their limits at once the message
      // still names one concrete, actionable cause instead of trying to describe both at once.
      const reason = bounceRate > bounceThreshold ? 'bounce_rate' : 'complaint_rate';
      const detail = reason === 'bounce_rate'
        ? `Bounce rate ${bounceRate.toFixed(1)}% exceeded your ${bounceThreshold}% limit (last 30 days).`
        : `Spam complaint rate ${complaintRate.toFixed(1)}% exceeded your ${complaintThreshold}% limit (last 30 days).`;
      await Mailboxes.setStatus(mb.id, 'paused', reason, detail);
      await AuditLog.record(null, 'mailbox_auto_paused', { mailbox_id: mb.id, email: mb.email, reason, bounce_rate: bounceRate, complaint_rate: complaintRate });
      console.warn(`[scheduler] auto-paused mailbox ${mb.email} (bounce ${bounceRate.toFixed(1)}%, complaint ${complaintRate.toFixed(1)}%)`);
    }
  }
}

// Pure math, no side effects - shared by the tick-start bulk sweep below and the mid-batch
// per-send check in processOneDueProspect, so the two can never drift apart on what "unhealthy"
// actually means. Returns null if the campaign is fine (or has no one enrolled yet to judge), or
// { reason, bounceRate, complaintRate } if it's crossed one of the two thresholds.
//
// The rate is bounces (or complaints) divided by the campaign's TOTAL RECIPIENTS - everyone ever
// added to the campaign - not by however many sends have gone out so far. This went through two
// designs before landing here:
//   1. Originally required >=20 total sends before evaluating at all, as a minimum sample size.
//      Problem: a campaign that was already well over threshold (a genuinely bad list) still got
//      to fully drain its first 20 sends before the very first check ever ran.
//   2. That floor was then removed entirely, evaluating from send #1. Problem: on a small list,
//      one unlucky early bounce (e.g. 1 bounce out of 1-2 sends = 100%/50%) could pause a healthy
//      29-person campaign almost instantly - indistinguishable from a real bad list.
//   3. This version: judge the rate against total recipients instead of total sent. A campaign
//      with 29 recipients and a 30% threshold now needs roughly 9 real bounces before it trips,
//      no matter how early those bounces land - 1 bounce out of 1 send is 1/29 = 3.4%, nowhere
//      near 30%. A small explicit list (e.g. 10 recipients, 30% threshold) still pauses exactly
//      when your own numbers say it should: the moment the 3rd of 10 bounces comes in (3/10=30%).
// Comparison is >= (not strictly >) so hitting the threshold exactly - like 3 bounces out of 10 at
// a 30% setting - counts as crossing it, matching that worked example directly.
//
// Complaint-rate evaluation was REMOVED by request, alongside removing "Pause a campaign if its
// own spam complaints exceed" from Settings (see frontend/src/pages/Settings.jsx) and disabling
// the two mailbox-level checks in autoPauseUnhealthyMailboxes above. Bounce rate is now the only
// thing that can ever pause a campaign.
function evaluateCampaignBounceHealth(row, settings = {}) {
  const bounceThreshold = Number(settings.auto_pause_campaign_bounce_rate_percent ?? process.env.AUTO_PAUSE_CAMPAIGN_BOUNCE_RATE_PERCENT ?? 3);
  const totalRecipients = Number(row?.total_recipients) || 0;
  if (totalRecipients < 1) return null; // no one enrolled yet - nothing to evaluate, avoids a divide-by-zero
  const bounceCount = Number(row?.bounce_count) || 0;
  const bounceRate = (bounceCount / totalRecipients) * 100;
  if (bounceRate >= bounceThreshold) {
    // bounceCount/totalRecipients are carried on the verdict (not just the rate) so callers can
    // log/display the real "3 of 10 bounced" figures, not just the derived percentage - added by
    // request so the pause-reason popup on the campaign page can show both.
    return { reason: 'bounce_rate', bounceRate, bounceCount, totalRecipients };
  }
  return null;
}

// Same idea as autoPauseUnhealthyMailboxes above, but scoped to one specific campaign instead of
// the whole mailbox - so if 3 campaigns share a mailbox and only one of them has a bad list, only
// that campaign stops, not the other two. Uses a real rolling 30-day window computed live from
// the sends table (Campaigns.bounceStatsLast30Days), not a stored counter, so it can never go
// stale the way a perpetually-incrementing counter would. Runs independently of the mailbox-level
// check above - both stay active as two separate layers of protection.
//
// This only runs once, at the very start of a tick - see checkAndPauseIfCampaignUnhealthy below
// for the per-send version that catches a campaign going bad mid-batch, not just between ticks.
async function autoPauseUnhealthyCampaigns(settings = {}) {
  const stats = await Campaigns.bounceStatsLast30Days();
  for (const row of stats) {
    const verdict = evaluateCampaignBounceHealth(row, settings);
    if (verdict) {
      await Campaigns.setStatus(row.campaign_id, 'paused');
      await AuditLog.record(null, 'campaign_auto_paused', {
        campaign_id: row.campaign_id, reason: verdict.reason, bounce_rate: verdict.bounceRate,
        bounce_count: verdict.bounceCount, total_recipients: verdict.totalRecipients
      });
      console.warn(`[scheduler] auto-paused campaign ${row.campaign_id} (${verdict.bounceCount}/${verdict.totalRecipients} bounced, ${verdict.bounceRate.toFixed(1)}%)`);
    }
  }
}

// The tick-start sweep above only runs once, before that tick's sending begins - a lane can then
// spend the next 30-80+ minutes working through dozens of due prospects (45-180s pacing between
// each) without ever re-checking bounce health again until the NEXT tick. That let a genuinely bad
// list fully drain before the pause ever caught it - exactly "why did it wait until everything was
// sent to pause?". This re-runs the same health math (evaluateCampaignBounceHealth) fresh, right
// before every single send in processOneDueProspect below, so a campaign can pause itself mid-batch
// the moment a new bounce (landing via the SES webhook or IMAP poll in real time, in between sends)
// actually pushes it over the line - not after the whole batch finishes.
async function checkAndPauseIfCampaignUnhealthy(campaignId, settings = {}) {
  const row = await Campaigns.bounceStatsForCampaign(campaignId);
  const verdict = evaluateCampaignBounceHealth(row, settings);
  if (!verdict) return false;
  await Campaigns.setStatus(campaignId, 'paused');
  await AuditLog.record(null, 'campaign_auto_paused', {
    campaign_id: campaignId, reason: verdict.reason, bounce_rate: verdict.bounceRate,
    bounce_count: verdict.bounceCount, total_recipients: verdict.totalRecipients, mid_batch: true
  });
  console.warn(`[scheduler] auto-paused campaign ${campaignId} mid-batch (${verdict.bounceCount}/${verdict.totalRecipients} bounced, ${verdict.bounceRate.toFixed(1)}%)`);
  return true;
}

// Small helper so every skip branch below logs to the live activity feed the same way,
// without repeating the same five fields at each call site.
function logSkip(cp, reason) {
  return ActivityLog.record({
    eventType: 'skipped',
    campaignId: cp.campaign_id,
    campaignName: cp.campaign_name,
    prospectEmail: cp.email,
    reason
  });
}

// A step_order can have up to 3 rows when it branches by engagement (see setStepBranches in
// repo.js): one for 'clicked', one for 'opened', one default (branch_condition null/none).
// Picks whichever one actually applies to this prospect, based on how they engaged with the
// PREVIOUS step they were sent - never the step being chosen itself. Clicking a link always
// means the email was opened too, so a 'clicked' branch outranks an 'opened' one whenever both
// would technically match. Step 1 (current_step 0) has no previous step to check, so it always
// resolves to whichever single row exists there - branching only ever starts from step 2 on.
async function pickStepVariant(candidates, cp) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const engagement = cp.current_step > 0 ? await Sends.getEngagement(cp.id, cp.current_step) : { opened: false, clicked: false };
  if (engagement.clicked) {
    const clicked = candidates.find((s) => s.branch_condition === 'clicked');
    if (clicked) return clicked;
  }
  if (engagement.opened) {
    const opened = candidates.find((s) => s.branch_condition === 'opened');
    if (opened) return opened;
  }
  return candidates.find((s) => !s.branch_condition) || candidates[0];
}

async function processOneDueProspect(cp, { baseUrl, companyName, companyAddress, settings }) {
  // Re-check the campaign's live status right before doing anything with this prospect - not
  // just once at the top of runOnce(). The due list is fetched ONCE per tick (already filtered
  // to c.status='active' at that moment), then processed one at a time with a real pacing delay
  // (often 45-180s) between sends. Without this check, pausing a campaign mid-tick did nothing
  // for whichever prospects were already pulled into that tick's in-memory batch - they'd keep
  // sending, one every 45-180s, for however long was left in the batch, because nothing here
  // ever looked at the campaign's status again after the initial fetch. This is exactly what
  // "I paused it and it kept sending" looks like from the outside.
  const liveCampaign = await Campaigns.get(cp.campaign_id);
  if (!liveCampaign || liveCampaign.status !== 'active') {
    await logSkip(cp, 'campaign_not_active');
    return { sent: false, reason: 'campaign_not_active' };
  }

  // Re-check THIS campaign's own live bounce/complaint rate right before sending to it - not just
  // once at the top of the tick (see checkAndPauseIfCampaignUnhealthy for why). If a bounce that
  // landed since the last check just pushed it over the threshold, pause it now and skip this
  // prospect too, instead of sending one more and only catching it next tick.
  if (await checkAndPauseIfCampaignUnhealthy(cp.campaign_id, settings)) {
    await logSkip(cp, 'campaign_auto_paused_mid_batch');
    return { sent: false, reason: 'campaign_auto_paused_mid_batch' };
  }

  // Optional per-campaign daily ceiling - independent of whatever the mailbox's own cap is, so
  // two campaigns sharing one mailbox can each be capped without either one starving the other
  // (e.g. mailbox cap 400/day, split as 200/day per campaign). Counts every send this campaign
  // has made today across every step/branch, not just first-touch emails. Checked before even
  // looking at mailbox capacity, since a campaign that's already used up its own day doesn't
  // need to compete for mailbox headroom at all.
  if (liveCampaign.daily_cap) {
    const sentToday = await Campaigns.sentTodayCount(cp.campaign_id);
    if (sentToday >= liveCampaign.daily_cap) {
      await logSkip(cp, 'campaign_daily_cap_reached');
      return { sent: false, reason: 'campaign_daily_cap_reached' };
    }
  }

  if (cp.is_suppressed) {
    await CampaignProspects.markStopped(cp.id, 'unsubscribed');
    await logSkip(cp, 'suppressed');
    return { sent: false, reason: 'suppressed' };
  }

  const steps = await Campaigns.listSteps(cp.campaign_id);
  const candidates = steps.filter((s) => s.step_order === cp.current_step + 1);
  const step = await pickStepVariant(candidates, cp);
  if (!step) {
    await CampaignProspects.markStopped(cp.id, 'completed');
    return { sent: false, reason: 'no_more_steps' };
  }

  // Engagement-aware skipping: if this step is flagged to skip when the prospect already
  // engaged with the previous step, advance without sending.
  if (step.skip_if_engaged && cp.current_step > 0) {
    const engaged = await Sends.hasEngagement(cp.id, cp.current_step);
    if (engaged) {
      const nextStep = steps.find((s) => s.step_order === cp.current_step + 2);
      const nextDue = nextStep ? toSqlDatetime(new Date(Date.now() + stepWaitMs(nextStep))) : null;
      await CampaignProspects.updateAfterSend(cp.id, cp.current_step + 1, nextDue);
      await logSkip(cp, 'skipped_engaged');
      return { sent: false, reason: 'skipped_engaged' };
    }
  }

  const okGap = await enforceGlobalMinimumGap(cp.email, settings);
  if (!okGap) {
    await logSkip(cp, 'min_gap_not_elapsed');
    return { sent: false, reason: 'min_gap_not_elapsed' };
  }

  const mailbox = await pickMailboxWithCapacity(cp.campaign_id);
  if (!mailbox) {
    await logSkip(cp, 'no_mailbox_capacity');
    return { sent: false, reason: 'no_mailbox_capacity' };
  }

  const template = await Templates.get(step.template_id);
  const token = makeToken();

  await sendTemplateToProspect({
    mailbox,
    template,
    prospect: cp,
    token,
    baseUrl,
    companyName,
    companyAddress
  });

  await Sends.create(cp.id, mailbox.id, step.step_order, token, step.id);
  await Mailboxes.incrementSentToday(mailbox.id);
  await ActivityLog.record({
    eventType: 'sent',
    campaignId: cp.campaign_id,
    campaignName: cp.campaign_name,
    prospectEmail: cp.email,
    mailboxEmail: mailbox.email,
    stepOrder: step.step_order,
    // Tags which branch fired (e.g. "clicked") so the live feed can show it - null/absent for
    // an ordinary, non-branching send, same as before this feature existed.
    reason: step.branch_condition || undefined
  });

  const nextStep = steps.find((s) => s.step_order === cp.current_step + 2);
  const nextDue = nextStep ? toSqlDatetime(new Date(Date.now() + stepWaitMs(nextStep))) : null;
  await CampaignProspects.updateAfterSend(cp.id, cp.current_step + 1, nextDue);

  return { sent: true };
}

// A scheduled campaign whose start time has arrived flips to 'active' here. Called from
// promoteAndCompleteDueCampaigns() below, independently of the main send loop's isRunning
// lock - see that function's comment for why that separation matters.
async function promoteScheduledCampaigns() {
  const promoted = await Campaigns.promoteDueSchedules(toSqlDatetime());
  for (const c of promoted) {
    console.log(`[scheduler] campaign ${c.id} (${c.name}) reached its scheduled start time - now active`);
    // Carry the original scheduled_at into this event too - the scheduler only polls once a
    // minute, so activation can land a little after the exact scheduled moment. Recording both
    // times lets the Timeline explain that gap instead of showing two entries that just look
    // like they disagree.
    await AuditLog.record(null, 'campaign_activated', { campaign_id: c.id, via: 'schedule', scheduled_for: c.scheduled_at });
  }
  return promoted;
}

// A campaign used to stay 'active' forever even once every recipient had fully finished the
// sequence (nothing left pending/in_progress) - there was no distinct "done" state, so the
// Campaigns list and progress bar had no honest way to show "this one's actually finished."
// Runs every tick, regardless of the send window, so status flips promptly rather than waiting
// for the window to reopen.
async function autoCompleteFinishedCampaigns() {
  const completed = await Campaigns.autoCompleteFinishedCampaigns();
  for (const c of completed) {
    console.log(`[scheduler] campaign ${c.id} (${c.name}) has no recipients left pending - marked completed`);
    await AuditLog.record(null, 'campaign_completed', { campaign_id: c.id });
  }
  return completed;
}

// Guards just this pair of checks against overlapping with themselves - not against the main
// send loop's isRunning lock below, which is the whole point (see promoteAndCompleteDueCampaigns).
let isPromoting = false;

// Runs promoteScheduledCampaigns()/autoCompleteFinishedCampaigns() on every tick, independently
// of the isRunning lock the main send loop uses. These two checks used to run INSIDE the
// isRunning-gated section below, right before the due-prospect loop - which meant a scheduled
// campaign's "has its start time arrived yet?" check was held hostage by whatever else the
// scheduler happened to be doing. A single tick's send loop processes up to a full batch of due
// prospects (SCHEDULER_BATCH_SIZE, default 25 - see the comment further down where it's read) one
// at a time with a real pacing delay between each, and if that campaign still has more due
// prospects waiting, the very next tick often re-acquires the lock immediately for another batch,
// leaving almost no gap for anything else to
// run. In production this left two separately-scheduled campaigns sitting as 'scheduled' for
// hours past their start time, purely because a third, unrelated campaign's large batch kept the
// lock busy the whole time (see the campaign_activated timeline gap on campaigns #64/#65,
// Sep 9 2026). Promoting a schedule or marking a campaign completed is a fast, one-shot database
// update with no pacing delay or outbound network call, so there's no real risk in letting it run
// even while a big send batch is mid-flight elsewhere - the `isPromoting` guard above is only
// there to stop this specific pair of checks from double-running against itself, not to block on
// the unrelated send loop.
async function promoteAndCompleteDueCampaigns() {
  if (isPromoting) return;
  isPromoting = true;
  try {
    await promoteScheduledCampaigns();
    await autoCompleteFinishedCampaigns();
  } catch (err) {
    console.error('[scheduler] promoteAndCompleteDueCampaigns failed:', err.message);
  } finally {
    isPromoting = false;
  }
}

// Guards against overlapping ticks: a single runOnce() call processes its due prospects one at
// a time with a pacing delay between each send (the "Send pace" setting, often tens of seconds
// to a few minutes total for several recipients). The cron job in server.js fires every 60
// seconds regardless of whether the previous tick finished - without this guard, a second tick
// could start while the first was still mid-send, re-fetch the SAME due prospects (since their
// current_step/next_due_at isn't updated in the DB until their send actually completes), and
// send them the same step again. This is exactly what caused a real duplicate-send incident:
// a 2-step, 4-recipient campaign sent Step 1 ten times instead of four. The fix: if a run is
// already in progress, a new tick skips instead of starting a second run on top of it.
let isRunning = false;

// Rolling in-memory record of the last few ticks - not persisted (a restart just starts a fresh
// buffer, same as `isRunning` above), purely so the app can show "is the background scheduler
// actually still alive" somewhere a person can see it, instead of that only ever being visible
// as a console.log line on a server most people never watch. Capped at MAX_RECENT_TICKS so this
// can never grow unbounded across a long-running process.
const MAX_RECENT_TICKS = 10;
const recentTicks = [];

function recordTick(result) {
  recentTicks.push({
    at: toSqlDatetime(),
    // The early-exit paths above (already_running / outside_send_window) set `skipped: true` as
    // a boolean flag, not a count - only treat it as a number when it actually is one, so those
    // ticks record as processed 0/sent 0/skipped 0 rather than the nonsensical `skipped: true`.
    processed: typeof result.processed === 'number' ? result.processed : 0,
    sent: typeof result.sent === 'number' ? result.sent : 0,
    skipped: typeof result.skipped === 'number' ? result.skipped : 0,
    reason: result.reason || null
  });
  if (recentTicks.length > MAX_RECENT_TICKS) recentTicks.shift();
}

async function runOnce(options) {
  // Runs on every tick regardless of whether the send loop below is mid-batch - see
  // promoteAndCompleteDueCampaigns()'s comment for why this can't sit inside runOnceInner
  // any more.
  await promoteAndCompleteDueCampaigns();
  const result = await runOnceInner(options);
  recordTick(result);
  return result;
}

async function runOnceInner({ ignoreWindow = false } = {}) {
  if (isRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;
  try {
    // Fetched once per tick so every guardrail check below (send window, pacing, min gap,
    // auto-pause thresholds) sees the same consistent snapshot of whatever's currently saved
    // in Settings - and so a change saved mid-run doesn't affect this tick, only the next one.
    const settings = await Settings.all();

    if (!ignoreWindow && !isWithinSendWindow(settings)) {
      return { skipped: true, reason: 'outside_send_window' };
    }

    // autoPauseUnhealthyMailboxes(settings) intentionally NOT called here anymore - mailbox-level
    // bounce/complaint auto-pause was disabled by request (see the DISABLED comment on that
    // function above). Only the campaign-level bounce-rate check below still runs.
    await autoPauseUnhealthyCampaigns(settings);

    const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
    const companyName = settings.company_name || process.env.COMPANY_NAME || 'Techforce Global';
    const companyAddress = settings.company_address || process.env.COMPANY_POSTAL_ADDRESS || '';

    // Caps how many due prospects a single tick will take (oldest-due first), instead of pulling
    // in the entire due backlog and serially working through all of it - with the pacing sleep
    // below running after every send, a large combined backlog (e.g. one campaign with tens of
    // thousands of recipients) could previously turn one tick into an hours-long run. Since
    // isRunning blocks a new tick from starting until the current one returns, that meant any
    // campaign activated (or cap/status change made) mid-run was invisible to the scheduler until
    // that one giant tick finally finished - it looked like campaigns were "stuck" or running
    // sequentially instead of together. Keeping each tick to a bounded batch means the next tick
    // (a minute or so later) always re-reads the current, up-to-date set of active campaigns.
    // Whatever isn't taken this tick simply stays due - next_due_at is untouched - and is picked
    // up automatically next time. Read from env (not a top-level const) so it can be overridden
    // per-test without needing to reload the module.
    //
    // Default lowered from 200 to 25 (real incident, Sep 2026): even with per-campaign fairness
    // and round-robin lane interleaving both in place (see listDue() and the lane-building code
    // below), 200 due prospects at a real 10-15s pace is still a 30-50 MINUTE tick - and a
    // campaign that gets activated, resumed, or newly assigned prospects a few seconds after that
    // tick's snapshot was taken still has to wait for the entire rest of that snapshot to drain
    // before the next tick can see it at all, no matter how fair the fetch/lane logic underneath
    // is. 25 keeps a single-campaign tick down to a few minutes, so a just-activated campaign is
    // realistically only ever one short tick away from being picked up, not 30-50 minutes away.
    const batchSize = Number(process.env.SCHEDULER_BATCH_SIZE) || 25;

    const due = await CampaignProspects.listDue(toSqlDatetime(), batchSize);
    const results = { processed: due.length, sent: 0, skipped: 0, details: [] };

    // A mailbox is a real, single-threaded resource - it can only actually send one email at a
    // time - but a campaign is just a logical grouping that borrows time from whichever mailbox
    // it's assigned. Before this change, every due prospect from every campaign went through one
    // shared loop, sleeping the pacing gap after every single send, regardless of mailbox - so
    // two campaigns on two completely unrelated mailboxes still took turns waiting on each other.
    // Grouping by mailbox and running each group's loop concurrently means campaigns on different
    // mailboxes genuinely run at the same time, while campaigns sharing one mailbox still queue up
    // and take turns on it fairly, exactly as a single mailbox has to.
    //
    // Each campaign is looked up once (not once per prospect) and cached here, since many due
    // rows in the same tick usually belong to the same handful of campaigns.
    const distinctCampaignIds = [...new Set(due.map((cp) => cp.campaign_id))];
    const mailboxesByCampaign = new Map(
      await Promise.all(distinctCampaignIds.map(async (id) => [id, await Campaigns.listMailboxes(id)]))
    );

    // Safety net for true concurrency: if the exact same prospect email happens to be due in two
    // DIFFERENT campaigns on two DIFFERENT mailboxes in the same tick (e.g. the same person is a
    // member of two lists, each targeted by its own campaign), those two sends would now run in
    // two different lanes at the same time. enforceGlobalMinimumGap looks at the `sends` table for
    // that email's last send - two concurrent lookups could both see "nothing recent yet" before
    // either has actually written its row, letting both through and silently bypassing the
    // configured minimum-gap-between-emails guardrail. The single shared loop this replaces never
    // had this risk, since one send always fully completed (and was recorded) before the next
    // prospect was even looked at. Only the first (earliest-due, since `due` is already sorted)
    // occurrence of a given email is kept for this tick; any later duplicate is simply left due -
    // next_due_at is untouched - and picked up for real on the next tick, once the first one's
    // send has actually landed in the database.
    const seenEmails = new Set();
    const dedupedDue = due.filter((cp) => {
      const key = (cp.email || '').toLowerCase();
      if (!key) return true;
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });

    // First, split into lanes by mailbox as before, but keep each lane's items grouped by WHICH
    // campaign they belong to (rather than flattening straight away) - a lane with only one
    // campaign in it collapses back to the exact same list either way, but a lane with several
    // campaigns sharing that one mailbox needs that grouping for the round-robin step below.
    const laneCampaignGroups = new Map(); // laneKey -> Map(campaignId -> cp[], each in due-time order)
    for (const cp of dedupedDue) {
      const mailboxes = mailboxesByCampaign.get(cp.campaign_id) || [];
      const laneKey = mailboxes.length > 0 ? `mailbox-${mailboxes[0].id}` : `no-mailbox-campaign-${cp.campaign_id}`;
      if (!laneCampaignGroups.has(laneKey)) laneCampaignGroups.set(laneKey, new Map());
      const campaignGroups = laneCampaignGroups.get(laneKey);
      if (!campaignGroups.has(cp.campaign_id)) campaignGroups.set(cp.campaign_id, []);
      campaignGroups.get(cp.campaign_id).push(cp);
    }

    // Round-robin across the campaigns sharing each lane, one prospect at a time, instead of
    // draining one campaign's entire due-time-sorted share before the next campaign gets a single
    // send. listDue() already guarantees every active campaign gets its own fair slice of the
    // per-tick batch (see repo.js), but a lane still processes its items strictly in the order
    // it's given - and since a campaign's WHOLE backlog carries whatever timestamp it was first
    // enrolled at, a bigger/earlier campaign sharing a mailbox with a smaller/newer one would
    // still completely monopolize every tick's shared queue before the newer one ever got a
    // single send, sometimes for hours (a real production case: campaigns #64/#65 sharing
    // mark@techforce.global, Sep 2026 - #65 sat at 0% the entire time #64's much larger, slightly
    // older backlog kept winning the ordering, even after per-campaign daily caps were set,
    // because those only help once the larger campaign actually exhausts its cap for the day).
    // Interleaving means two (or more) campaigns sharing one mailbox now alternate sends from the
    // very first tick - each campaign's own items stay in their own due-time order internally,
    // only the ACROSS-campaign ordering changes. A lane with just one campaign in it is completely
    // unaffected: the loop below just drains its single queue in the same order as before.
    const lanes = new Map(); // laneKey -> cp[], round-robin interleaved across that lane's campaigns
    for (const [laneKey, campaignGroups] of laneCampaignGroups) {
      const queues = [...campaignGroups.values()];
      const interleaved = [];
      let anyRemaining = true;
      while (anyRemaining) {
        anyRemaining = false;
        for (const queue of queues) {
          if (queue.length > 0) {
            interleaved.push(queue.shift());
            anyRemaining = true;
          }
        }
      }
      lanes.set(laneKey, interleaved);
    }

    async function processLane(laneItems) {
      const laneResult = { sent: 0, skipped: 0, details: [] };
      for (const cp of laneItems) {
        // Isolate each prospect: one bad SMTP send (wrong credentials, host
        // unreachable, etc.) must not abort the rest of the batch. Before this fix,
        // a single throw here escaped the loop entirely, silently skipping every
        // other due prospect for the whole 5-minute cycle with no visible cause.
        let result;
        try {
          result = await processOneDueProspect(cp, { baseUrl, companyName, companyAddress, settings });
        } catch (err) {
          console.error(`[scheduler] failed to process campaign_prospect ${cp.id} (${cp.email}):`, err.message);
          result = { sent: false, reason: 'error', error: err.message };
        }
        laneResult.details.push({ campaign_prospect_id: cp.id, email: cp.email, ...result });
        if (result.sent) {
          laneResult.sent += 1;
          await sleep(randomDelayMs(cp, settings));
        } else {
          laneResult.skipped += 1;
        }
      }
      return laneResult;
    }

    // Every lane runs concurrently (this is the actual parallelism) - within a lane, sends still
    // happen one at a time, in order, exactly like the loop this replaces.
    const laneResults = await Promise.all([...lanes.values()].map(processLane));
    for (const laneResult of laneResults) {
      results.sent += laneResult.sent;
      results.skipped += laneResult.skipped;
      results.details.push(...laneResult.details);
    }
    return results;
  } finally {
    isRunning = false;
  }
}

module.exports = {
  runOnce,
  // Newest-last, like every other list in this app that reads top-to-bottom as a timeline.
  getRecentTicks: () => recentTicks.slice(),
  isWithinSendWindow,
  pickMailboxWithCapacity,
  autoPauseUnhealthyMailboxes,
  autoPauseUnhealthyCampaigns,
  checkAndPauseIfCampaignUnhealthy,
  promoteScheduledCampaigns,
  autoCompleteFinishedCampaigns,
  promoteAndCompleteDueCampaigns,
  randomDelayMs,
  estimateEffectiveStart,
  projectCampaignCompletion,
  stepWaitMs,
  // Exported only so smoke-test.js can exercise the pause-mid-tick race directly (fetch a due
  // snapshot, THEN pause, THEN process that exact stale snapshot) - runOnce() itself processes
  // its whole due list in one call, so there's no other way to reproduce that exact ordering
  // from outside the module.
  processOneDueProspect
};

const express = require('express');
const router = express.Router();
const { Campaigns, AuditLog, Analytics, Templates, Tags, Settings, Sends } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');
const { toSqlDatetime, zonedTimeToUtc } = require('../lib/dates');
const { estimateEffectiveStart, projectCampaignCompletion } = require('../lib/scheduler');

router.use(requireAuth);

// Attaches a guardrail-aware "sending will actually begin around ..." estimate to any
// scheduled campaign, computed fresh from its stored scheduled_at plus whatever the Sending
// guardrails currently say - so if guardrails change later, older campaigns' estimates stay
// accurate rather than showing a stale value from whenever they were scheduled.
async function withEstimatedStart(campaign, settings) {
  if (!campaign || campaign.status !== 'scheduled' || !campaign.scheduled_at) return campaign;
  const candidate = new Date(campaign.scheduled_at.replace(' ', 'T') + 'Z');
  const estimated = estimateEffectiveStart(candidate, settings);
  return { ...campaign, estimated_start_at: estimated ? toSqlDatetime(estimated) : null };
}

router.get('/', asyncHandler(async (req, res) => {
  const [campaigns, settings] = await Promise.all([Campaigns.list(), Settings.all()]);
  res.json(await Promise.all(campaigns.map((c) => withEstimatedStart(c, settings))));
}));

// Guardrail-only preview of "when would sending actually begin for this candidate date/time"
// - used both for the live helper text under the schedule date picker (candidate = whatever
// the user just picked) and the "Send now instead" confirm dialog (candidate = right now,
// when `at` is omitted). Registered before /:id so "estimate-start" isn't swallowed as an id.
router.get('/estimate-start', asyncHandler(async (req, res) => {
  const tz = process.env.APP_TIMEZONE || 'UTC';
  let candidate;
  if (req.query.at) {
    try {
      candidate = zonedTimeToUtc(req.query.at, tz);
    } catch (e) {
      candidate = new Date(NaN); // zonedTimeToUtc throws on a genuinely unparseable string
    }
    if (Number.isNaN(candidate.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
  } else {
    candidate = new Date();
  }
  const settings = await Settings.all();
  const estimated = estimateEffectiveStart(candidate, settings);
  res.json({
    candidate_at: toSqlDatetime(candidate),
    estimated_start_at: estimated ? toSqlDatetime(estimated) : null,
    within_window: !!(estimated && estimated.getTime() === candidate.getTime()),
    send_window_start_hour: Number(settings.send_window_start_hour ?? process.env.SEND_WINDOW_START_HOUR ?? 9),
    send_window_end_hour: Number(settings.send_window_end_hour ?? process.env.SEND_WINDOW_END_HOUR ?? 18),
    send_only_weekdays: (settings.send_only_weekdays ?? process.env.SEND_ONLY_WEEKDAYS) !== 'false'
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const campaign = await Campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const steps = await Campaigns.listSteps(req.params.id);
  const mailboxes = await Campaigns.listMailboxes(req.params.id);
  // Just the ids, not the full prospect table - see GET /:id/prospects below for the actual
  // (paginated) table data. Keeping ids here is what lets the "Add/remove by list" checkboxes
  // compute overlap against the campaign's ENTIRE membership regardless of how that table itself
  // is paginated, without shipping every prospect's full row (email, engagement flags, etc.) on
  // every single campaign-detail load - the thing that made this page slow once a campaign had
  // thousands of prospects.
  const prospect_ids = await Campaigns.listProspectIds(req.params.id);
  // Only computed when this campaign actually has its own daily cap set - a real query per
  // load isn't worth paying for on every campaign that doesn't use the feature.
  const sent_today = campaign.daily_cap ? await Campaigns.sentTodayCount(req.params.id) : null;
  const stats = await Analytics.forCampaign(req.params.id);
  const timeline = await AuditLog.forCampaign(req.params.id);
  const tags = await Campaigns.listTags(req.params.id);
  const stepActivity = await Campaigns.stepActivity(req.params.id);

  // First step's template/mailbox stand in for the "Subject / From / Reply-to" preview
  // block, same idea as a single-send tool's campaign header - useful at a glance
  // before drilling into the full sequence below.
  let preview = null;
  if (steps.length > 0) {
    const firstTemplate = await Templates.get(steps[0].template_id);
    const firstMailbox = mailboxes[0];
    preview = {
      subject: firstTemplate?.subject || '',
      from_name: firstTemplate?.sender_name || firstMailbox?.display_name || '',
      from_email: firstMailbox?.email || '',
      reply_to: firstMailbox?.email || ''
    };
  }

  const settings = await Settings.all();
  const campaignWithEstimate = await withEstimatedStart({ ...campaign, steps, mailboxes, prospect_ids, sent_today, stats, timeline, preview, tags, stepActivity }, settings);
  res.json(campaignWithEstimate);
}));

// Paginated, search-filtered prospect table for the campaign detail page - separate from the
// main GET /:id above so opening a campaign's page never depends on how many prospects it has.
router.get('/:id/prospects', asyncHandler(async (req, res) => {
  const result = await Campaigns.searchCampaignProspects(req.params.id, { q: req.query.q, page: req.query.page, pageSize: req.query.page_size });
  res.json(result);
}));

// Read-only, per-send detail (one row per email actually sent) - lets a specific "I got this
// email twice" report be checked precisely by email + step, instead of only inferred from the
// aggregate per-step counts on stepActivity above.
router.get('/:id/sends', asyncHandler(async (req, res) => {
  const campaign = await Campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(await Sends.listByCampaign(req.params.id));
}));

// "How long will this whole campaign actually take" projection, shown alongside estimate-start
// in the Schedule/Send-now confirm popup - built from THIS campaign's real prospect count, step
// count, and assigned mailboxes' real capacity (including anyone still on the warmup ramp), not
// a generic guess. Accepts the same optional `at` param as estimate-start so the projection
// starts counting from whatever moment is actually being scheduled/sent from.
router.get('/:id/estimate-completion', asyncHandler(async (req, res) => {
  const campaign = await Campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const tz = process.env.APP_TIMEZONE || 'UTC';
  let candidate;
  if (req.query.at) {
    try {
      candidate = zonedTimeToUtc(req.query.at, tz);
    } catch (e) {
      candidate = new Date(NaN);
    }
    if (Number.isNaN(candidate.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
  } else {
    candidate = new Date();
  }

  const [settings, stats, mailboxes] = await Promise.all([
    Settings.all(),
    Analytics.forCampaign(req.params.id),
    Campaigns.listMailboxes(req.params.id)
  ]);

  const effectiveStart = estimateEffectiveStart(candidate, settings) || candidate;
  const prospectsCount = stats ? Number(stats.recipients) : 0;
  const stepCount = stats ? Number(stats.total_steps) : 0;
  // 0 for a campaign that hasn't sent anything yet (draft/scheduled - the pre-launch popup's
  // original use case, unaffected), or the real sequence-wide progress so far for one that's
  // already active - see projectCampaignCompletion's own comment for why this makes the exact
  // same call double as a "how much longer from here" estimate for a live campaign.
  const alreadyCompletedSteps = stats ? Number(stats.current_step_sum) : 0;

  const projection = projectCampaignCompletion({ startDate: effectiveStart, mailboxes, prospectsCount, stepCount, settings, alreadyCompletedSteps });

  res.json({
    prospects_count: prospectsCount,
    step_count: stepCount,
    mailboxes_count: mailboxes.filter((m) => m.status !== 'paused').length,
    ...projection
  });
}));

// No length cap on the name itself - it's stored in full (VARCHAR(255)) and shown in full via
// a hover tooltip anywhere it's displayed. Only the visible, truncated label is capped (see
// truncateName() in Campaigns.jsx), so the underlying name a user typed is never silently cut
// off or rejected just because a display column is narrow.
router.post('/', asyncHandler(async (req, res) => {
  const { name, sending_mode } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required' });
  if (await Campaigns.findByName(name)) return res.status(400).json({ error: `A campaign named "${name.trim()}" already exists` });
  const result = await Campaigns.create(name, sending_mode, req.user.id);
  await AuditLog.record(req.user.id, 'campaign_created', { campaign_id: result.insertId, name });
  res.json({ id: result.insertId, name });
}));

// Rename a campaign - the only field on the campaign row itself that's ever needed editing
// after creation (sending_mode isn't exposed anywhere in the UI to change).
router.patch('/:id', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required' });
  const campaign = await Campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const trimmed = name.trim();
  const existing = await Campaigns.findByName(trimmed);
  if (existing && String(existing.id) !== String(req.params.id)) {
    return res.status(400).json({ error: `A campaign named "${trimmed}" already exists` });
  }
  await Campaigns.rename(req.params.id, trimmed);
  await AuditLog.record(req.user.id, 'campaign_renamed', { campaign_id: req.params.id, old_name: campaign.name, new_name: trimmed });
  res.json({ ok: true, name: trimmed });
}));

router.post('/:id/mailboxes', asyncHandler(async (req, res) => {
  const { mailbox_ids } = req.body; // array
  if (!Array.isArray(mailbox_ids) || mailbox_ids.length === 0) {
    return res.status(400).json({ error: 'At least one mailbox id is required' });
  }
  for (const mid of mailbox_ids) await Campaigns.assignMailbox(req.params.id, mid);
  await AuditLog.record(req.user.id, 'mailboxes_assigned_to_campaign', { campaign_id: req.params.id, count: mailbox_ids.length });
  res.json({ ok: true });
}));

// Unassign a single mailbox - the previous mailbox picker was add-only, with no way to walk
// one back off a campaign (e.g. swapping in a fresh mailbox) short of deleting the whole
// campaign. Deliberately allowed even on an active campaign - same as removing a sequence
// step, this is an intentional configuration change, not something that needs blocking.
router.delete('/:id/mailboxes/:mailboxId', asyncHandler(async (req, res) => {
  await Campaigns.removeMailbox(req.params.id, req.params.mailboxId);
  await AuditLog.record(req.user.id, 'mailbox_removed_from_campaign', { campaign_id: req.params.id, mailbox_id: req.params.mailboxId });
  res.json({ ok: true });
}));

// Sequence builder: each step has its own editable wait_days + wait_hours + wait_minutes (no
// fixed default), and an optional "skip if already opened/clicked" engagement condition.
// wait_hours/wait_minutes let a step wait a partial day (e.g. "3 hours, 30 minutes later")
// rather than only whole-day gaps.
router.post('/:id/steps', asyncHandler(async (req, res) => {
  const { step_order, template_id, wait_days, wait_hours, wait_minutes, skip_if_engaged } = req.body;
  if (!template_id || wait_days === undefined || wait_days === null) {
    return res.status(400).json({ error: 'Template and wait days are required for each step' });
  }
  if (wait_hours !== undefined && wait_hours !== null && (Number.isNaN(Number(wait_hours)) || Number(wait_hours) < 0)) {
    return res.status(400).json({ error: 'Wait hours must be a non-negative number' });
  }
  if (wait_minutes !== undefined && wait_minutes !== null && (Number.isNaN(Number(wait_minutes)) || Number(wait_minutes) < 0)) {
    return res.status(400).json({ error: 'Wait minutes must be a non-negative number' });
  }
  await Campaigns.addStep(req.params.id, step_order, template_id, wait_days, skip_if_engaged, Number(wait_hours) || 0, Number(wait_minutes) || 0);
  await AuditLog.record(req.user.id, 'sequence_step_added', { campaign_id: req.params.id, step_order });
  res.json({ ok: true });
}));

// In-place edit of an existing step (template / wait days+hours+minutes / skip-if-engaged) -
// unlike add/remove this never changes step_order or how many steps exist, so no renumbering or
// prospect-progress adjustment is needed. Step 1 still has no wait of its own (it fires when
// the campaign starts), so wait_days/wait_hours/wait_minutes are forced to 0 for it regardless
// of what's submitted.
router.patch('/:id/steps/:stepId', asyncHandler(async (req, res) => {
  const { template_id, wait_days, wait_hours, wait_minutes, skip_if_engaged } = req.body;
  if (!template_id || wait_days === undefined || wait_days === null) {
    return res.status(400).json({ error: 'Template and wait days are required for each step' });
  }
  if (wait_hours !== undefined && wait_hours !== null && (Number.isNaN(Number(wait_hours)) || Number(wait_hours) < 0)) {
    return res.status(400).json({ error: 'Wait hours must be a non-negative number' });
  }
  if (wait_minutes !== undefined && wait_minutes !== null && (Number.isNaN(Number(wait_minutes)) || Number(wait_minutes) < 0)) {
    return res.status(400).json({ error: 'Wait minutes must be a non-negative number' });
  }
  const existing = await Campaigns.getStep(req.params.id, req.params.stepId);
  if (!existing) return res.status(404).json({ error: 'Sequence step not found' });
  const isFirstStep = existing.step_order === 1;
  await Campaigns.updateStep(req.params.id, req.params.stepId, {
    templateId: template_id,
    waitDays: isFirstStep ? 0 : Number(wait_days),
    waitHours: isFirstStep ? 0 : (Number(wait_hours) || 0),
    waitMinutes: isFirstStep ? 0 : (Number(wait_minutes) || 0),
    skipIfEngaged: skip_if_engaged
  });
  await AuditLog.record(req.user.id, 'sequence_step_updated', { campaign_id: req.params.id, step_order: existing.step_order });
  res.json({ ok: true });
}));

// Fully replaces a step's branch configuration - the single write path for both converting a
// simple step into one that branches by engagement (up to 3 rows: clicked/opened/default) and
// back again (1 row), and for editing an existing branching step. A simple, non-branching step
// keeps using the plain POST/PATCH endpoints above unchanged - this endpoint only comes into
// play once the "branch by engagement" toggle is actually on, so most campaigns never touch it.
router.put('/:id/steps/:stepOrder/branches', asyncHandler(async (req, res) => {
  const stepOrder = Number(req.params.stepOrder);
  const { wait_days, wait_hours, wait_minutes, branches } = req.body;

  if (!Array.isArray(branches) || branches.length === 0) {
    return res.status(400).json({ error: 'At least one branch (template) is required' });
  }
  if (wait_days === undefined || wait_days === null) {
    return res.status(400).json({ error: 'Wait days is required' });
  }
  if (wait_hours !== undefined && wait_hours !== null && (Number.isNaN(Number(wait_hours)) || Number(wait_hours) < 0)) {
    return res.status(400).json({ error: 'Wait hours must be a non-negative number' });
  }
  if (wait_minutes !== undefined && wait_minutes !== null && (Number.isNaN(Number(wait_minutes)) || Number(wait_minutes) < 0)) {
    return res.status(400).json({ error: 'Wait minutes must be a non-negative number' });
  }
  for (const b of branches) {
    if (!b.template_id) return res.status(400).json({ error: 'Every branch needs a template' });
    if (b.condition && !['opened', 'clicked'].includes(b.condition)) {
      return res.status(400).json({ error: 'Branch condition must be "opened" or "clicked"' });
    }
  }
  const conditions = branches.map((b) => b.condition || null);
  if (new Set(conditions).size !== conditions.length) {
    return res.status(400).json({ error: 'Each branch condition can only be used once per step' });
  }
  if (branches.length > 1) {
    if (stepOrder === 1) {
      return res.status(400).json({ error: "Step 1 can't branch - there's no previous step to check engagement on" });
    }
    if (!conditions.includes(null)) {
      return res.status(400).json({ error: 'A branching step needs a default template for prospects with no matching engagement' });
    }
  }

  const isFirstStep = stepOrder === 1;
  await Campaigns.setStepBranches(req.params.id, stepOrder, {
    waitDays: isFirstStep ? 0 : Number(wait_days),
    waitHours: isFirstStep ? 0 : (Number(wait_hours) || 0),
    waitMinutes: isFirstStep ? 0 : (Number(wait_minutes) || 0),
    skipIfEngaged: false,
    branches
  });
  await AuditLog.record(req.user.id, 'sequence_step_branches_set', { campaign_id: req.params.id, step_order: stepOrder, branch_count: branches.length });
  res.json({ ok: true });
}));

// Removes a single sequence step - see Campaigns.removeStep in repo.js for how the remaining
// steps get renumbered and in-flight prospects' progress gets kept consistent.
router.delete('/:id/steps/:stepId', asyncHandler(async (req, res) => {
  const step = await Campaigns.removeStep(req.params.id, req.params.stepId);
  if (!step) return res.status(404).json({ error: 'Sequence step not found' });
  await AuditLog.record(req.user.id, 'sequence_step_removed', { campaign_id: req.params.id, step_order: step.step_order });
  res.json({ ok: true });
}));

// Add prospects to a live or draft campaign - can be called repeatedly (e.g. add 100 today,
// 100 more tomorrow); new prospects start fresh at step 1 without affecting anyone already
// mid-sequence.
router.post('/:id/prospects', asyncHandler(async (req, res) => {
  const { prospect_ids } = req.body;
  if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
    return res.status(400).json({ error: 'At least one prospect id is required' });
  }
  const campaignBefore = await Campaigns.get(req.params.id);
  const result = await Campaigns.addProspects(req.params.id, prospect_ids);
  await AuditLog.record(req.user.id, 'prospects_added_to_campaign', {
    campaign_id: req.params.id,
    added: result.added,
    skipped_suppressed: result.skippedSuppressed
  });

  // A 'completed' campaign only got that status because nothing was left pending for it -
  // the scheduler's listDue() only ever looks at status='active' campaigns, so without this,
  // freshly added prospects would just sit there forever, never picked up. Flip it back to
  // active automatically (paused campaigns are left alone - that's a deliberate stop, not
  // "finished", so it shouldn't be undone just by adding a list).
  let reactivated = false;
  if (campaignBefore && campaignBefore.status === 'completed' && result.added > 0) {
    await Campaigns.setStatus(req.params.id, 'active');
    await AuditLog.record(req.user.id, 'campaign_reactivated_for_new_prospects', {
      campaign_id: req.params.id,
      added: result.added
    });
    reactivated = true;
  }

  res.json({ added: result.added, skippedSuppressed: result.skippedSuppressed, reactivated });
}));

// Removes prospects from THIS campaign only - the recovery path for "added the wrong list/too
// many prospects by mistake". Never touches the prospect's contact record, so they're untouched
// in every other campaign and list they belong to. A POST (not DELETE) because it takes a
// bulk array in the body, same shape as the add-prospects endpoint above, rather than a single
// id in the URL - large corrections (thousands of rows) are exactly what this exists for.
router.post('/:id/prospects/remove', asyncHandler(async (req, res) => {
  const { prospect_ids } = req.body;
  if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
    return res.status(400).json({ error: 'At least one prospect id is required' });
  }
  const result = await Campaigns.removeProspects(req.params.id, prospect_ids);
  await AuditLog.record(req.user.id, 'prospects_removed_from_campaign', {
    campaign_id: req.params.id,
    removed: result.removed,
    requested: prospect_ids.length
  });
  res.json({ removed: result.removed });
}));

// A campaign that goes active/scheduled with no mailbox or no sequence step looks "live" in
// the UI but silently never sends anything - the scheduler either finds no mailbox with
// capacity, or finds no step 1 and immediately marks every prospect completed. Rather than
// let that happen invisibly, both entry points into "actually sending" are gated here.
async function assertReadyToSend(campaignId) {
  const [mailboxes, steps] = await Promise.all([Campaigns.listMailboxes(campaignId), Campaigns.listSteps(campaignId)]);
  const missing = [];
  if (mailboxes.length === 0) missing.push('a sending mailbox');
  if (steps.length === 0) missing.push('at least one sequence step');
  if (missing.length > 0) {
    const err = new Error(`This campaign needs ${missing.join(' and ')} before it can send.`);
    err.status = 400;
    throw err;
  }
}

router.post('/:id/activate', asyncHandler(async (req, res) => {
  await assertReadyToSend(req.params.id);
  await Campaigns.setStatus(req.params.id, 'active');
  await AuditLog.record(req.user.id, 'campaign_activated', { campaign_id: req.params.id });
  res.json({ ok: true });
}));

// Schedule a future start instead of sending immediately. `scheduled_at` is a "wall clock"
// datetime-local string (e.g. "2026-07-25T14:30") in APP_TIMEZONE - converted to a real UTC
// instant here so it compares correctly against the scheduler's UTC clock.
router.post('/:id/schedule', asyncHandler(async (req, res) => {
  await assertReadyToSend(req.params.id);
  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at (date and time) is required' });
  const tz = process.env.APP_TIMEZONE || 'UTC';
  const utcDate = zonedTimeToUtc(scheduled_at, tz);
  if (Number.isNaN(utcDate.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
  if (utcDate.getTime() <= Date.now()) return res.status(400).json({ error: 'Scheduled time must be in the future' });

  const sqlDatetime = toSqlDatetime(utcDate);
  await Campaigns.schedule(req.params.id, sqlDatetime);
  await AuditLog.record(req.user.id, 'campaign_scheduled', { campaign_id: req.params.id, scheduled_at: sqlDatetime });
  res.json({ ok: true, scheduled_at: sqlDatetime });
}));

router.post('/:id/unschedule', asyncHandler(async (req, res) => {
  await Campaigns.cancelSchedule(req.params.id);
  await AuditLog.record(req.user.id, 'campaign_schedule_cancelled', { campaign_id: req.params.id });
  res.json({ ok: true });
}));

router.post('/:id/pause', asyncHandler(async (req, res) => {
  await Campaigns.setStatus(req.params.id, 'paused');
  await AuditLog.record(req.user.id, 'campaign_paused', { campaign_id: req.params.id });
  res.json({ ok: true });
}));

// Per-campaign pacing: how many seconds the scheduler waits between sending each email
// in this specific campaign. Passing nulls for both reverts to the global .env default.
// A small floor (5s) is enforced either way - sending with zero delay looks like a bot
// blast to mailbox providers and will tank deliverability fast.
router.post('/:id/send-interval', asyncHandler(async (req, res) => {
  let { min_seconds, max_seconds } = req.body;
  if (min_seconds === undefined) min_seconds = null;
  if (max_seconds === undefined) max_seconds = null;

  if (min_seconds !== null || max_seconds !== null) {
    if (min_seconds === null || max_seconds === null) {
      return res.status(400).json({ error: 'Provide both a minimum and a maximum, or leave both blank to use the default' });
    }
    min_seconds = Number(min_seconds);
    max_seconds = Number(max_seconds);
    if (!Number.isFinite(min_seconds) || !Number.isFinite(max_seconds)) {
      return res.status(400).json({ error: 'Seconds must be numbers' });
    }
    if (min_seconds < 5 || max_seconds < 5) {
      return res.status(400).json({ error: 'Minimum allowed gap is 5 seconds - going lower reads as a bot blast to mailbox providers' });
    }
    if (max_seconds < min_seconds) {
      return res.status(400).json({ error: 'Maximum must be greater than or equal to the minimum' });
    }
  }

  await Campaigns.setSendInterval(req.params.id, min_seconds, max_seconds);
  await AuditLog.record(req.user.id, 'campaign_send_interval_updated', { campaign_id: req.params.id, min_seconds, max_seconds });
  res.json({ ok: true, min_seconds_between_sends: min_seconds, max_seconds_between_sends: max_seconds });
}));

// Optional per-campaign daily send ceiling - independent of whatever the mailbox's own cap is.
// Lets two campaigns sharing one mailbox each be capped without either one starving the other
// (see lib/scheduler.js processOneDueProspect for where this is actually enforced). Passing
// null/blank clears it - back to only the mailbox's own cap applying, same as before this existed.
router.post('/:id/daily-cap', asyncHandler(async (req, res) => {
  let { daily_cap } = req.body;
  if (daily_cap === undefined || daily_cap === '') daily_cap = null;
  if (daily_cap !== null) {
    daily_cap = Number(daily_cap);
    if (!Number.isFinite(daily_cap) || daily_cap < 1) {
      return res.status(400).json({ error: 'Daily cap must be a positive number, or blank for no campaign-level limit' });
    }
    daily_cap = Math.round(daily_cap);
  }
  await Campaigns.setDailyCap(req.params.id, daily_cap);
  await AuditLog.record(req.user.id, 'campaign_daily_cap_updated', { campaign_id: req.params.id, daily_cap });
  res.json({ ok: true, daily_cap });
}));

// Clones this campaign (sequence, mailboxes, tags, pace, recipients) into a new draft - see
// Campaigns.duplicate() for exactly what's copied vs. reset. Logs an audit entry on BOTH
// campaigns (each keyed by its own campaign_id in meta) so either one's Timeline shows the
// cross-link, not just the new copy's.
router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const result = await Campaigns.duplicate(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Campaign not found' });
  await AuditLog.record(req.user.id, 'campaign_duplicated', {
    campaign_id: result.id, source_campaign_id: result.sourceId, source_name: result.sourceName
  });
  await AuditLog.record(req.user.id, 'campaign_duplicated', {
    campaign_id: result.sourceId, new_campaign_id: result.id, new_name: result.name
  });
  res.json({ id: result.id, name: result.name, prospectsAdded: result.prospectsAdded, prospectsSkippedSuppressed: result.prospectsSkippedSuppressed });
}));

// Permanently removes a campaign and everything scoped to it (sends/tracking history,
// recipients, sequence steps, mailbox assignments) - unlike pause/unschedule, this can't be
// undone, so it's restricted to admins/managers same as removing a mailbox, domain, or list.
router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const campaign = await Campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  await Campaigns.remove(req.params.id);
  await AuditLog.record(req.user.id, 'campaign_removed', { name: campaign.name });
  res.json({ ok: true });
}));

// Assigns an existing tag to a campaign. Creating new tags is handled by POST /api/tags -
// this route only links a tag_id that already exists to this campaign.
router.post('/:id/tags', asyncHandler(async (req, res) => {
  const { tag_id } = req.body;
  if (!tag_id) return res.status(400).json({ error: 'A tag_id is required' });
  const tag = await Tags.get(tag_id);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  await Campaigns.addTag(req.params.id, tag_id);
  await AuditLog.record(req.user.id, 'tag_assigned_to_campaign', { campaign_id: req.params.id, tag_id, name: tag.name });
  res.json({ ok: true });
}));

router.delete('/:id/tags/:tagId', asyncHandler(async (req, res) => {
  await Campaigns.removeTag(req.params.id, req.params.tagId);
  await AuditLog.record(req.user.id, 'tag_removed_from_campaign', { campaign_id: req.params.id, tag_id: req.params.tagId });
  res.json({ ok: true });
}));

module.exports = router;

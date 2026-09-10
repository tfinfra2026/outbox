// Live "send activity" feed - powers the terminal-style log screen on the frontend. Polled
// every few seconds rather than pushed over a socket, same tradeoff the rest of this app
// already makes elsewhere (e.g. the campaign progress bar) for simplicity over infrastructure.
const express = require('express');
const router = express.Router();
const { ActivityLog, Campaigns, Mailboxes, AuditLog, Lists } = require('../db/repo');
const { requireAuth } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');
const { zonedTimeToUtc, toSqlDatetime } = require('../lib/dates');
const { getRecentTicks } = require('../lib/scheduler');
const { toCsv } = require('../lib/csv');

router.use(requireAuth);

// Mirrors ActivityLog.jsx's PILL/REASON_LABEL maps on the frontend - kept in sync by hand since
// the export needs the same friendly wording as the on-screen feed, just as plain text instead
// of a colored pill (a raw 'no_mailbox_capacity'/'skipped' would mean nothing to someone opening
// this in Excel who's never seen the app's UI).
const EVENT_TYPE_LABEL = { sent: 'Sent', skipped: 'Skipped', bounced: 'Bounced', opened: 'Opened', clicked: 'Clicked' };
const REASON_LABEL = {
  suppressed: 'Suppressed',
  skipped_engaged: 'Already engaged',
  min_gap_not_elapsed: 'Min gap not elapsed',
  no_mailbox_capacity: 'No mailbox capacity',
  campaign_daily_cap_reached: "Campaign's own daily cap reached",
  campaign_not_active: 'Campaign paused/stopped',
  campaign_auto_paused_mid_batch: 'Campaign auto-paused mid-batch (bounce/complaint rate)',
  hard: 'Hard bounce',
  soft: 'Soft bounce',
  complaint: 'Spam complaint',
  clicked: 'Clicked branch',
  opened: 'Opened branch'
};

// Shared by /search and /export - turns the raw query-string filters (plain 'YYYY-MM-DD' dates,
// a comma-separated types list) into what ActivityLog._buildFilter actually wants: UTC
// 'YYYY-MM-DD HH:MM:SS' boundaries (converted from the app's own timezone, so "today" means the
// same thing here as it does on the Activity page's "Sent today" stat) and a real array of types.
function parseActivityFilters(query) {
  const tz = process.env.APP_TIMEZONE || 'UTC';
  const { q, campaign_id, types, start_date, end_date } = query;
  const eventTypes = types ? String(types).split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const startAt = start_date ? toSqlDatetime(zonedTimeToUtc(`${start_date}T00:00`, tz)) : undefined;
  // zonedTimeToUtc only reads hour:minute (see lib/dates.js) - 23:59 is as close to end-of-day
  // as it resolves, which is plenty precise for a date-range boundary.
  const endAt = end_date ? toSqlDatetime(zonedTimeToUtc(`${end_date}T23:59`, tz)) : undefined;
  return { q, campaignId: campaign_id || undefined, eventTypes, startAt, endAt };
}

// ?after_id=<id> - only rows newer than the last one the client already has, for polling.
// Omit it for the initial page load, which returns the most recent `limit` rows instead.
router.get('/', asyncHandler(async (req, res) => {
  const { after_id, limit } = req.query;
  const [events, stats, campaignsActive, mailboxes] = await Promise.all([
    ActivityLog.list({ afterId: after_id, limit }),
    ActivityLog.statsToday(),
    Campaigns.countActive(),
    Mailboxes.countOnline()
  ]);
  res.json({
    events,
    stats: {
      sent: stats.sent,
      skipped: stats.skipped,
      bounced: stats.bounced,
      active_campaigns: campaignsActive,
      mailboxes_online: mailboxes.online,
      mailboxes_total: mailboxes.total
    },
    // Rolling last-10-ticks record from the background scheduler (see lib/scheduler.js) - lets
    // the Activity page show that the cron job itself is actually still alive and running on
    // schedule, separate from whether any particular campaign has activity to report.
    scheduler_ticks: getRecentTicks()
  });
}));

// Paginated, filterable history browse - separate from the live-tail feed above. Lets someone
// actually dig through thousands of past events (search by email/campaign, filter by type and
// date range, page back as far as the data goes) instead of only ever seeing the last ~300 rows
// the live feed keeps in the browser.
router.get('/search', asyncHandler(async (req, res) => {
  const filters = parseActivityFilters(req.query);
  const result = await ActivityLog.search({ ...filters, page: req.query.page, pageSize: req.query.page_size });
  res.json(result);
}));

// Same filters as /search, but returns every matching row (capped at 20,000) as a downloadable
// CSV instead of a JSON page - for taking a filtered slice of activity history into Excel/Sheets.
router.get('/export', asyncHandler(async (req, res) => {
  const filters = parseActivityFilters(req.query);
  const rows = await ActivityLog.exportRows(filters);
  const tz = process.env.APP_TIMEZONE || 'UTC';

  // Which list each prospect email currently belongs to (if any) - a prospect can be in more
  // than one, so this is a comma-joined name, not a single value. Looked up in one batched query
  // for every distinct email in this export rather than per-row, same reasoning as
  // Lists.removeWithProspects' chunking.
  const listNamesByEmail = await Lists.namesByEmail(rows.map((r) => r.prospect_email));

  // Stored as 'YYYY-MM-DD HH:MM:SS' UTC (see lib/dates.js) - parsed as UTC then rendered in the
  // app's own configured timezone, same as every timestamp already shown on the Activity page,
  // instead of dumping the raw naive UTC string a spreadsheet would have no way to place.
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  });

  // Column headers and per-row values are built separately from the raw db columns so the
  // download reads like a real report - friendly capitalized headers, the same human-readable
  // event/reason labels the on-screen feed uses (not raw 'no_mailbox_capacity'/'skipped' codes),
  // and a properly localized date/time - one column per field, lined up the same way the
  // History grid on-screen is, so it opens cleanly into its own columns in Excel/Sheets.
  const columns = ['Date/Time', 'Event', 'Campaign', 'Prospect Email', 'List', 'Mailbox', 'Step', 'Reason'];
  const exportRows = rows.map((r) => ({
    'Date/Time': r.created_at ? dateFmt.format(new Date(r.created_at.replace(' ', 'T') + 'Z')) : '',
    Event: EVENT_TYPE_LABEL[r.event_type] || r.event_type || '',
    Campaign: r.campaign_name || '',
    'Prospect Email': r.prospect_email || '',
    List: listNamesByEmail[r.prospect_email] || '',
    Mailbox: r.mailbox_email || '',
    Step: r.step_order || '',
    Reason: REASON_LABEL[r.reason] || r.reason || ''
  }));
  const csv = toCsv(exportRows, columns);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// Clears the leftover activity history for one campaign - only allowed once the campaign itself
// no longer exists (it shows up on the Activity page tagged "deleted campaign"). This is a
// separate, explicit cleanup step rather than something Campaigns' own delete does automatically,
// since the whole point of keeping these rows after a campaign is removed is to preserve a
// historical send record - deleting them is opt-in, not a side effect of deleting the campaign.
router.delete('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const campaignId = Number(req.params.campaignId);
  const campaign = await Campaigns.get(campaignId);
  if (campaign) {
    return res.status(400).json({ error: "This campaign still exists - remove the campaign itself from the Campaigns page instead of clearing its activity history here." });
  }
  await ActivityLog.deleteForCampaign(campaignId);
  await AuditLog.record(req.user.id, 'activity_log_cleared_for_deleted_campaign', { campaign_id: campaignId });
  res.json({ ok: true });
}));

module.exports = router;

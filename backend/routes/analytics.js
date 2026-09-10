const express = require('express');
const router = express.Router();
const { Analytics, Suppression, Lists } = require('../db/repo');
const { requireAuth } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');

router.use(requireAuth);

// Matches the agreed summary layout: Sent/Bounces, Recipients/Delivered, Opens/Open rate,
// Clicks/Click rate, Unsubscribes/Unsub rate. Replies intentionally excluded.
router.get('/summary', asyncHandler(async (req, res) => {
  const s = await Analytics.summary();
  const delivered = s.sent - s.bounced;
  const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0);
  res.json({
    sent: s.sent,
    bounces: s.bounced,
    recipients: s.sent,
    delivered,
    opens: s.opened,
    open_rate: pct(s.opened, s.sent),
    clicks: s.clicked,
    click_rate: pct(s.clicked, s.sent),
    unsubscribes: s.unsubscribed,
    unsub_rate: pct(s.unsubscribed, s.sent)
  });
}));

// Merges in per-step sent counts and mailbox daily-cap headroom for every campaign, computed
// with two extra grouped queries (see Analytics.stepActivityAll/mailboxCapacityAll) rather than
// one query per campaign - the Campaigns list page's "Running behind"/"Sending" info tooltip
// needs both of these for every row it shows a progress bar on.
router.get('/campaigns', asyncHandler(async (req, res) => {
  const [perCampaign, stepActivity, mailboxCapacity] = await Promise.all([
    Analytics.perCampaign(),
    Analytics.stepActivityAll(),
    Analytics.mailboxCapacityAll()
  ]);

  const stepsByCampaign = new Map();
  stepActivity.forEach((row) => {
    if (!stepsByCampaign.has(row.campaign_id)) stepsByCampaign.set(row.campaign_id, []);
    stepsByCampaign.get(row.campaign_id).push({ step_order: row.step_order, sent_count: Number(row.sent_count) || 0 });
  });
  const capacityByCampaign = new Map(mailboxCapacity.map((r) => [r.campaign_id, r]));

  res.json(perCampaign.map((c) => {
    const capacity = capacityByCampaign.get(c.id);
    return {
      ...c,
      step_sent: stepsByCampaign.get(c.id) || [],
      active_daily_cap_total: capacity ? Number(capacity.active_daily_cap_total) || 0 : null,
      active_mailbox_count: capacity ? Number(capacity.active_mailbox_count) || 0 : 0,
      mailbox_count: capacity ? Number(capacity.mailbox_count) || 0 : 0
    };
  }));
}));

// Enriched with which list (if any) each suppressed email currently belongs to, so the Settings
// page's Suppression list table can show it alongside which campaign caused the suppression -
// a prospect can be in more than one list, hence the comma-joined 'list' field rather than a
// single id/name.
//
// Paginated + searchable (q/page/page_size, same query-param names ActivityLog's /search uses)
// rather than always returning every suppressed email - added once the table got a search box
// and pager of its own. list-name enrichment only runs against the current page's rows now, not
// every row in the table, so this stays cheap as the list grows.
router.get('/suppression-list', asyncHandler(async (req, res) => {
  const { q, page, page_size } = req.query;
  const result = await Suppression.search({ q, page, pageSize: page_size });
  const listNamesByEmail = await Lists.namesByEmail(result.rows.map((r) => r.email));
  res.json({ ...result, rows: result.rows.map((r) => ({ ...r, list: listNamesByEmail[r.email] || '' })) });
}));

module.exports = router;

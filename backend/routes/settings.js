const express = require('express');
const router = express.Router();
const { Settings, AuditLog, Suppression, Lists } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');
const { SENDING_GUARDRAILS } = require('../lib/defaultSettings');
const { encrypt } = require('../lib/crypto');
const { DEFAULT_MODEL } = require('../lib/aiTemplates');
const { toCsv } = require('../lib/csv');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const all = await Settings.all();
  const { openrouter_api_key_encrypted, ...safe } = all; // never expose the encrypted credential to the frontend
  res.json(safe);
}));

// The frontend uses this to render each guardrail's label/unit/description next to its input,
// so the UI and the backend can never drift out of sync on what a value actually means.
router.get('/guardrail-meta', (req, res) => res.json(SENDING_GUARDRAILS));

// Sanity-checks the sending guardrails whenever the save touches any of them - merged against
// whatever's already saved, so a partial save (e.g. just the daily cap) still gets checked
// against the current min/max pairing instead of only the fields present in this request.
function validateGuardrails(incoming, current) {
  const merged = { ...current, ...incoming };
  const num = (key) => Number(merged[key]);
  const touches = (key) => Object.prototype.hasOwnProperty.call(incoming, key);

  if (touches('default_daily_cap') && !(num('default_daily_cap') >= 1)) {
    return 'Default daily cap must be a positive number';
  }
  if (touches('warmup_start_cap') && !(num('warmup_start_cap') >= 1)) {
    return 'Warmup start cap must be a positive number';
  }
  if (touches('warmup_ramp_days') && !(num('warmup_ramp_days') >= 1)) {
    return 'Warmup ramp length must be a positive number of days';
  }
  if ((touches('warmup_start_cap') || touches('default_daily_cap')) && num('warmup_start_cap') > num('default_daily_cap')) {
    return 'Warmup start cap cannot be higher than the default daily cap';
  }
  if (touches('min_hours_between_emails_to_same_prospect') && !(num('min_hours_between_emails_to_same_prospect') >= 0)) {
    return 'Min gap per prospect must be zero or a positive number of hours';
  }
  if (touches('send_window_start_hour') && !(num('send_window_start_hour') >= 0 && num('send_window_start_hour') <= 23)) {
    return 'Send window start must be an hour between 0 and 23';
  }
  if (touches('send_window_end_hour') && !(num('send_window_end_hour') >= 0 && num('send_window_end_hour') <= 23)) {
    return 'Send window end must be an hour between 0 and 23';
  }
  if ((touches('send_window_start_hour') || touches('send_window_end_hour')) && num('send_window_end_hour') <= num('send_window_start_hour')) {
    return 'Send window end must be later than the send window start';
  }
  if (touches('min_seconds_between_sends') && !(num('min_seconds_between_sends') >= 0)) {
    return 'Min delay between sends must be zero or a positive number of seconds';
  }
  if (touches('max_seconds_between_sends') && !(num('max_seconds_between_sends') >= 0)) {
    return 'Max delay between sends must be zero or a positive number of seconds';
  }
  if (
    (touches('min_seconds_between_sends') || touches('max_seconds_between_sends')) &&
    num('max_seconds_between_sends') < num('min_seconds_between_sends')
  ) {
    return 'Max delay between sends must be greater than or equal to the min delay';
  }
  if (
    touches('auto_pause_bounce_rate_percent') &&
    !(num('auto_pause_bounce_rate_percent') >= 0 && num('auto_pause_bounce_rate_percent') <= 100)
  ) {
    return 'Auto-pause bounce rate must be a percentage between 0 and 100';
  }
  if (
    touches('auto_pause_complaint_rate_percent') &&
    !(num('auto_pause_complaint_rate_percent') >= 0 && num('auto_pause_complaint_rate_percent') <= 100)
  ) {
    return 'Auto-pause complaint rate must be a percentage between 0 and 100';
  }
  if (
    touches('auto_pause_campaign_bounce_rate_percent') &&
    !(num('auto_pause_campaign_bounce_rate_percent') >= 0 && num('auto_pause_campaign_bounce_rate_percent') <= 100)
  ) {
    return 'Auto-pause campaign bounce rate must be a percentage between 0 and 100';
  }
  if (
    touches('auto_pause_campaign_complaint_rate_percent') &&
    !(num('auto_pause_campaign_complaint_rate_percent') >= 0 && num('auto_pause_campaign_complaint_rate_percent') <= 100)
  ) {
    return 'Auto-pause campaign complaint rate must be a percentage between 0 and 100';
  }
  return null;
}

router.put('/', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const current = await Settings.all();
  const validationError = validateGuardrails(req.body, current);
  if (validationError) return res.status(400).json({ error: validationError });

  for (const [key, value] of Object.entries(req.body)) {
    if (key === 'openrouter_api_key_encrypted') continue; // must go through POST /openrouter-key so it's always encrypted
    await Settings.set(key, String(value));
  }
  await AuditLog.record(req.user.id, 'settings_updated', { keys: Object.keys(req.body) });
  res.json({ ok: true });
}));

// Status only - never returns the encrypted key itself, just whether one is configured and its
// last 4 characters, enough for the Settings UI to show "Connected · ····3f2a" without exposing it.
router.get('/openrouter-key/status', asyncHandler(async (req, res) => {
  const settings = await Settings.all();
  res.json({
    connected: !!settings.openrouter_api_key_encrypted,
    last4: settings.openrouter_key_last4 || null,
    model: settings.openrouter_model || DEFAULT_MODEL
  });
}));

router.post('/openrouter-key', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { api_key, model } = req.body;
  if (api_key && api_key.trim()) {
    await Settings.set('openrouter_api_key_encrypted', encrypt(api_key.trim()));
    await Settings.set('openrouter_key_last4', api_key.trim().slice(-4));
  }
  if (model && model.trim()) await Settings.set('openrouter_model', model.trim());
  await AuditLog.record(req.user.id, 'openrouter_key_updated', {});
  res.json({ ok: true });
}));

router.post('/suppression', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { email, reason } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  await Suppression.add(email.toLowerCase().trim(), reason || 'manual');
  await AuditLog.record(req.user.id, 'suppression_added_manually', { email });
  res.json({ ok: true });
}));

router.delete('/suppression/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const email = await Suppression.remove(req.params.id);
  if (!email) return res.status(404).json({ error: 'Suppression list entry not found' });
  await AuditLog.record(req.user.id, 'suppression_removed', { email });
  res.json({ ok: true, email });
}));

// Downloads the full suppression list as a CSV - same pattern as Lists' per-row export and the
// Activity page's History export (fetch as a blob on the frontend, since this is a file
// response, not JSON).
router.get('/suppression/export', asyncHandler(async (req, res) => {
  const rows = await Suppression.list();
  // Which list (if any) each suppressed email currently belongs to - same lookup and same
  // comma-joined format as the on-screen table (routes/analytics.js's /suppression-list).
  const listNamesByEmail = await Lists.namesByEmail(rows.map((r) => r.email));
  const exportRows = rows.map((r) => ({ ...r, list: listNamesByEmail[r.email] || '' }));
  const columns = ['id', 'email', 'reason', 'campaign_name', 'list', 'created_at'];
  const csv = toCsv(exportRows, columns);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="suppression-list-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

module.exports = router;

const express = require('express');
const router = express.Router();
const { Mailboxes, AuditLog } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const { encrypt } = require('../lib/crypto');
const { safeCapForToday, warmupStatus } = require('../lib/warmup');
const asyncHandler = require('../lib/asyncHandler');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const mailboxes = await Mailboxes.list();
  const enriched = mailboxes.map((mb) => {
    const { smtp_pass_encrypted, imap_pass_encrypted, ...safe } = mb; // never expose encrypted credentials to the frontend
    return { ...safe, safe_cap_today: safeCapForToday(mb), warmup_status: warmupStatus(mb) };
  });
  res.json(enriched);
}));

router.post('/', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { domain_id, email, display_name, smtp_host, smtp_port, smtp_user, smtp_password, daily_cap } = req.body;
  if (!email || !display_name || !smtp_host || !smtp_user || !smtp_password) {
    return res.status(400).json({ error: 'Email, display name, SMTP host, username and password are all required' });
  }
  const result = await Mailboxes.create({
    domain_id: domain_id || null,
    email,
    display_name,
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass_encrypted: encrypt(smtp_password),
    daily_cap
  });
  await AuditLog.record(req.user.id, 'mailbox_added', { email });
  res.json({ id: result.insertId, email });
}));

// Edit a mailbox's identity/connection details after creation - display name, SMTP host/port/user,
// sending domain, and optionally the password. Password is optional on purpose: leaving it blank
// keeps the existing encrypted credential rather than requiring it to be re-entered every time.
router.patch('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const mailbox = await Mailboxes.get(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  const { domain_id, email, display_name, smtp_host, smtp_port, smtp_user, smtp_password } = req.body;
  if (!email || !display_name || !smtp_host || !smtp_user) {
    return res.status(400).json({ error: 'Email, display name, SMTP host and username are all required' });
  }

  const smtp_pass_encrypted = smtp_password ? encrypt(smtp_password) : mailbox.smtp_pass_encrypted;

  await Mailboxes.updateDetails(req.params.id, {
    domain_id: domain_id || null,
    email,
    display_name,
    smtp_host,
    smtp_port: smtp_port || 587,
    smtp_user,
    smtp_pass_encrypted
  });
  await AuditLog.record(req.user.id, 'mailbox_details_updated', { id: req.params.id, email });

  const updated = await Mailboxes.get(req.params.id);
  const { smtp_pass_encrypted: _omit, imap_pass_encrypted: _omit2, ...safe } = updated;
  res.json(safe);
}));

// Adjust a mailbox's sending caps after the fact - e.g. raise the warmup starting cap
// close to the final daily cap so it stops being throttled day-to-day, or correct a
// daily_cap that was set too low/high at creation time.
router.patch('/:id/caps', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const mailbox = await Mailboxes.get(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  const daily_cap = req.body.daily_cap !== undefined ? Number(req.body.daily_cap) : mailbox.daily_cap;
  const warmup_start_cap = req.body.warmup_start_cap !== undefined ? Number(req.body.warmup_start_cap) : mailbox.warmup_start_cap;
  const warmup_ramp_days = req.body.warmup_ramp_days !== undefined ? Number(req.body.warmup_ramp_days) : mailbox.warmup_ramp_days;

  if (!Number.isFinite(daily_cap) || daily_cap < 1) return res.status(400).json({ error: 'Daily cap must be a positive number' });
  if (!Number.isFinite(warmup_start_cap) || warmup_start_cap < 1) return res.status(400).json({ error: 'Warmup start cap must be a positive number' });
  if (!Number.isFinite(warmup_ramp_days) || warmup_ramp_days < 1) return res.status(400).json({ error: 'Warmup ramp days must be a positive number' });
  if (warmup_start_cap > daily_cap) return res.status(400).json({ error: 'Warmup start cap cannot be higher than the daily cap' });

  await Mailboxes.updateCaps(req.params.id, { daily_cap, warmup_start_cap, warmup_ramp_days });
  await AuditLog.record(req.user.id, 'mailbox_caps_updated', { id: req.params.id, daily_cap, warmup_start_cap, warmup_ramp_days });
  res.json(await Mailboxes.get(req.params.id));
}));

// Configures how this specific mailbox reports bounces/complaints back to the app - see the
// bounce_capture_method column comment in db/schema.*.sql. 'ses' needs no extra fields here (the
// webhook URL is the same shared one for every SES mailbox, shown by the frontend as static
// text); 'imap' needs real IMAP connection details, since that's what lib/bounceCapture.js uses
// to log into this mailbox's own inbox on a schedule; 'none' clears it back to unconfigured.
router.patch('/:id/bounce-capture', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const mailbox = await Mailboxes.get(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  const { bounce_capture_method, imap_host, imap_port, imap_user, imap_password } = req.body;
  if (!['ses', 'imap', 'none'].includes(bounce_capture_method)) {
    return res.status(400).json({ error: 'bounce_capture_method must be one of: ses, imap, none' });
  }
  if (bounce_capture_method === 'imap' && (!imap_host || !imap_user)) {
    return res.status(400).json({ error: 'IMAP host and username are required to poll this mailbox for bounces' });
  }
  // Password is optional on re-save, same convention as the SMTP password on PATCH /:id -
  // leaving it blank keeps whatever's already encrypted rather than requiring re-entry every time.
  if (bounce_capture_method === 'imap' && !imap_password && !mailbox.imap_pass_encrypted) {
    return res.status(400).json({ error: 'An IMAP password is required the first time you enable IMAP capture for this mailbox' });
  }

  const imap_pass_encrypted = imap_password ? encrypt(imap_password) : mailbox.imap_pass_encrypted;

  await Mailboxes.updateBounceCaptureSettings(req.params.id, {
    bounce_capture_method,
    imap_host: bounce_capture_method === 'imap' ? imap_host : mailbox.imap_host,
    imap_port: bounce_capture_method === 'imap' ? (imap_port || 993) : mailbox.imap_port,
    imap_user: bounce_capture_method === 'imap' ? imap_user : mailbox.imap_user,
    imap_pass_encrypted
  });
  await AuditLog.record(req.user.id, 'mailbox_bounce_capture_updated', { id: req.params.id, bounce_capture_method });

  const updated = await Mailboxes.get(req.params.id);
  const { smtp_pass_encrypted: _o1, imap_pass_encrypted: _o2, ...safe } = updated;
  res.json(safe);
}));

router.post('/:id/pause', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  await Mailboxes.setStatus(req.params.id, 'paused');
  await AuditLog.record(req.user.id, 'mailbox_paused', { id: req.params.id });
  res.json({ ok: true });
}));

router.post('/:id/resume', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  await Mailboxes.setStatus(req.params.id, 'active');
  await AuditLog.record(req.user.id, 'mailbox_resumed', { id: req.params.id });
  res.json({ ok: true });
}));

// Capacity planner: total safe sending ceiling today across every non-paused mailbox,
// plus a simple projection of when the pool will reach a target volume.
router.get('/capacity-planner', asyncHandler(async (req, res) => {
  const mailboxes = await Mailboxes.list();
  const active = mailboxes.filter((m) => m.status !== 'paused');
  const totalToday = active.reduce((sum, m) => sum + safeCapForToday(m), 0);
  const warmingCount = active.filter((m) => warmupStatus(m) === 'warming').length;
  const fullyRampedCount = active.filter((m) => warmupStatus(m) === 'active').length;
  const totalAtFullRamp = active.reduce((sum, m) => sum + (m.daily_cap || 30), 0);
  res.json({
    mailboxes_active: active.length,
    mailboxes_warming: warmingCount,
    mailboxes_fully_ramped: fullyRampedCount,
    safe_ceiling_today: totalToday,
    safe_ceiling_once_fully_ramped: totalAtFullRamp
  });
}));

router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const mailbox = await Mailboxes.get(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
  await Mailboxes.remove(req.params.id);
  await AuditLog.record(req.user.id, 'mailbox_removed', { email: mailbox.email });
  res.json({ ok: true });
}));

module.exports = router;

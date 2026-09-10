const express = require('express');
const multer = require('multer');
const router = express.Router();
const { Prospects, Suppression, AuditLog, Lists } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');
const { toSqlDatetime } = require('../lib/dates');
const { verifyEmail } = require('../lib/emailVerification');

const upload = multer({ dest: 'uploads/' });
const fs = require('fs');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => res.json(await Prospects.list())));

// Used by the Home and Prospects pages for the "Total contacts" / "New in the last 30
// days" cards, without either page having to pull down and count the full list itself.
router.get('/stats', asyncHandler(async (req, res) => {
  const thirtyDaysAgo = toSqlDatetime(new Date(Date.now() - 30 * 86400000));
  const [total, newLast30Days] = await Promise.all([Prospects.count(), Prospects.countSince(thirtyDaysAgo)]);
  res.json({ total, new_last_30_days: newLast30Days });
}));

// Prospects only ever enter a campaign by way of a list (see the campaign detail page's
// "add from list" flow), so a list is required here too - otherwise a prospect could be
// created with no way to ever get added to a campaign.
router.post('/', asyncHandler(async (req, res) => {
  const { email, first_name, last_name, company, list_id } = req.body;
  const trimmedEmail = (email || '').toLowerCase().trim();
  if (!trimmedEmail || !trimmedEmail.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
  if (!list_id) return res.status(400).json({ error: 'A list is required' });
  const list = await Lists.get(list_id);
  if (!list) return res.status(400).json({ error: 'That list no longer exists' });

  // Checked *before* writing anything - an email already in this exact list is treated as a
  // validation failure (not a silent no-op), per how this form should behave. The same email
  // in a *different* list is fine - that's a normal, allowed case (Lists.addProspects below
  // would create a new list_prospects row for it, same as always).
  const existingContact = await Prospects.findByEmail(trimmedEmail);
  if (existingContact) {
    const alreadyInThisList = await Lists.isMember(list_id, existingContact.id);
    if (alreadyInThisList) return res.status(400).json({ error: 'This email already exists in this selected list' });
  }

  const prospect = await Prospects.upsert({ email: trimmedEmail, first_name, last_name, company });
  await Lists.addProspects(list_id, [prospect.id]);
  res.json({ ...prospect, was_existing_contact: !!existingContact });
}));

// Edit a contact's identity fields only - email, name, company. List membership and any
// in-progress campaign steps are untouched (those are managed from Lists / the campaign itself).
router.patch('/:id', asyncHandler(async (req, res) => {
  const prospect = await Prospects.get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Contact not found' });

  const { email, first_name, last_name, company } = req.body;
  const trimmedEmail = (email || '').toLowerCase().trim();
  if (!trimmedEmail || !trimmedEmail.includes('@')) return res.status(400).json({ error: 'A valid email is required' });

  const existing = await Prospects.findByEmail(trimmedEmail);
  if (existing && existing.id !== prospect.id) return res.status(400).json({ error: 'Another contact already uses this email' });

  await Prospects.update(req.params.id, { email: trimmedEmail, first_name, last_name, company });
  await AuditLog.record(req.user.id, 'prospect_updated', { id: req.params.id, email: trimmedEmail });
  res.json(await Prospects.get(req.params.id));
}));

// Permanently removes a contact and everything scoped to them (sends/tracking history,
// campaign progress, list memberships) - unlike suppressing, this can't be undone.
router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const prospect = await Prospects.get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'Contact not found' });
  await Prospects.remove(req.params.id);
  await AuditLog.record(req.user.id, 'prospect_removed', { email: prospect.email });
  res.json({ ok: true });
}));

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] || ''));
    return row;
  });
  return { headers, rows };
}

// Batch CSV import - the frontend parses the CSV itself (for the approval preview) and sends
// pre-parsed rows here in chunks, so it can show a real per-batch progress bar instead of one
// opaque multipart upload. Every row is run through the verification pipeline first (syntax,
// disposable-domain, domain/MX, role-based heuristic - see lib/emailVerification.js); only a
// "deliverable" row proceeds to the existing new/existing/already-in-list logic below. Anything
// else (risky, invalid, disposable, unknown) is rejected outright and counted, never written to
// the database - this is deliberate (see the conversation this was scoped from: the goal is
// keeping bad addresses out of the outbox entirely, not flagging-and-keeping them). In-file
// duplicate collapsing happens client-side before rows ever get here, since that only requires
// the file itself, not a database round trip.
router.post('/import-batch', asyncHandler(async (req, res) => {
  const { list_id, rows } = req.body;
  if (!list_id) return res.status(400).json({ error: 'A list is required' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' });
  const list = await Lists.get(list_id);
  if (!list) return res.status(400).json({ error: 'That list no longer exists' });

  let newContacts = 0;
  let existingLinked = 0;
  let alreadyInList = 0;
  let suppressedCount = 0;
  let deliverable = 0;
  let risky = 0;
  let invalid = 0;
  let disposable = 0;
  let unknown = 0;

  for (const row of rows) {
    const email = (row.email || '').toLowerCase().trim();
    const verdict = await verifyEmail(email);

    // 'unknown' (a DNS lookup timeout/hiccup - inconclusive, not a confirmed bad domain) is let
    // through and added as a contact same as deliverable, per explicit decision - rejecting on a
    // resolver hiccup risks throwing away perfectly good contacts. It's still counted separately
    // below so the breakdown stays honest about which addresses were actually confirmed vs. just
    // never proven bad. Risky/disposable/invalid remain rejected outright.
    if (verdict.status !== 'deliverable' && verdict.status !== 'unknown') {
      if (verdict.status === 'risky') risky += 1;
      else if (verdict.status === 'disposable') disposable += 1;
      else invalid += 1;
      continue; // rejected - never written to the database
    }
    if (verdict.status === 'unknown') unknown += 1; else deliverable += 1;

    const existingContact = await Prospects.findByEmail(email);
    if (existingContact) {
      const alreadyMember = await Lists.isMember(list_id, existingContact.id);
      if (alreadyMember) {
        alreadyInList += 1;
        continue; // nothing changed for this row - no writes needed
      }
    }

    if (await Suppression.isSuppressed(email)) suppressedCount += 1;

    const prospect = await Prospects.upsert({
      email,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      company: row.company || ''
    });
    await Lists.addProspects(list_id, [prospect.id]);

    if (existingContact) existingLinked += 1; else newContacts += 1;
  }

  await AuditLog.record(req.user.id, 'prospects_imported', {
    newContacts, existingLinked, alreadyInList, suppressedCount, deliverable, risky, invalid, disposable, unknown, list_id
  });
  res.json({
    newContacts, existingLinked, alreadyInList, suppressedCount,
    deliverable, risky, invalid, disposable, unknown,
    processed: rows.length
  });
}));

// CSV upload with automatic field mapping by header name (email, first_name, last_name, company).
router.post('/import', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const listId = req.body.list_id || null;
  if (!listId) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'A list is required' });
  }
  const list = await Lists.get(listId);
  if (!list) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'That list no longer exists' });
  }
  const text = fs.readFileSync(req.file.path, 'utf8');
  fs.unlink(req.file.path, () => {});
  const { rows } = parseCsv(text);

  let imported = 0;
  let invalid = 0;
  let suppressed = 0;

  for (const row of rows) {
    const email = (row.email || row['e-mail'] || '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      invalid += 1;
      continue;
    }
    const isSuppressed = await Suppression.isSuppressed(email);
    if (isSuppressed) suppressed += 1;
    const prospect = await Prospects.upsert({
      email,
      first_name: row.first_name || row.firstname || '',
      last_name: row.last_name || row.lastname || '',
      company: row.company || ''
    });
    if (listId) await Lists.addProspects(listId, [prospect.id]);
    imported += 1;
  }

  await AuditLog.record(req.user.id, 'prospects_imported', { imported, invalid, suppressed, list_id: listId });
  res.json({ imported, invalid, already_suppressed: suppressed, total_rows: rows.length });
}));

module.exports = router;

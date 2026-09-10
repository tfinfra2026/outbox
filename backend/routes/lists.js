const express = require('express');
const router = express.Router();
const { Lists, AuditLog } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');
const { toCsv } = require('../lib/csv');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => res.json(await Lists.list())));

// All prospect->list memberships in one call - lets the Prospects page render each
// row's list badges and support "filter by list" without a request per prospect.
router.get('/memberships', asyncHandler(async (req, res) => res.json(await Lists.allMemberships())));

router.post('/', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { name, folder } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'List name is required' });
  if (await Lists.findByName(name)) return res.status(400).json({ error: `A list named "${name.trim()}" already exists` });
  const result = await Lists.create(name, folder);
  await AuditLog.record(req.user.id, 'list_created', { list_id: result.insertId, name });
  res.json({ id: result.insertId, name });
}));

router.get('/:id/prospects', asyncHandler(async (req, res) => res.json(await Lists.listProspects(req.params.id))));

// Downloads every prospect currently in this list as a CSV - same pattern as the Activity page's
// History export (fetch as a blob on the frontend, since this is a file response, not JSON).
router.get('/:id/export', asyncHandler(async (req, res) => {
  const list = await Lists.get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const prospects = await Lists.listProspects(req.params.id);
  const columns = ['id', 'email', 'first_name', 'last_name', 'company', 'is_suppressed'];
  const csv = toCsv(prospects, columns);
  const safeName = (list.name || 'list').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'list';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-prospects-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

router.post('/:id/prospects', asyncHandler(async (req, res) => {
  const { prospect_ids } = req.body;
  if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
    return res.status(400).json({ error: 'At least one prospect id is required' });
  }
  const added = await Lists.addProspects(req.params.id, prospect_ids);
  await AuditLog.record(req.user.id, 'prospects_added_to_list', { list_id: req.params.id, count: added });
  res.json({ added });
}));

router.delete('/:id/prospects/:prospectId', asyncHandler(async (req, res) => {
  await Lists.removeProspect(req.params.id, req.params.prospectId);
  res.json({ ok: true });
}));

router.patch('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'List name is required' });
  const list = await Lists.get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const existing = await Lists.findByName(name);
  if (existing && String(existing.id) !== String(req.params.id)) {
    return res.status(400).json({ error: `A list named "${name.trim()}" already exists` });
  }
  await Lists.rename(req.params.id, name);
  await AuditLog.record(req.user.id, 'list_renamed', { list_id: req.params.id, from: list.name, to: name });
  res.json({ id: Number(req.params.id), name });
}));

// Deleting a list permanently deletes every prospect in it (see Lists.removeWithProspects for
// why) - not reversible, so the frontend must show a real warning with the affected count
// before calling this, not a generic "are you sure?".
router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const list = await Lists.get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const { deletedProspectCount } = await Lists.removeWithProspects(req.params.id);
  await AuditLog.record(req.user.id, 'list_removed', { name: list.name, deletedProspectCount });
  res.json({ ok: true, deletedProspectCount });
}));

module.exports = router;

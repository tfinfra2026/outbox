const express = require('express');
const router = express.Router();
const { Tags, AuditLog } = require('../db/repo');
const { requireAuth } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => res.json(await Tags.list())));

// All campaign->tag assignments in one call - lets the Campaigns list page render each
// row's tag pills without a request per campaign, same idea as /api/lists/memberships.
router.get('/campaign-assignments', asyncHandler(async (req, res) => res.json(await Tags.allCampaignTags())));

router.post('/', asyncHandler(async (req, res) => {
  const { name, color } = req.body;
  const trimmedName = (name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'Tag name is required' });
  if (!color) return res.status(400).json({ error: 'Tag color is required' });
  const existing = await Tags.findByName(trimmedName);
  if (existing) return res.status(400).json({ error: 'A tag with that name already exists' });
  const result = await Tags.create(trimmedName, color);
  const tag = await Tags.get(result.insertId);
  await AuditLog.record(req.user.id, 'tag_created', { tag_id: tag.id, name: tag.name });
  res.json(tag);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const tag = await Tags.get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  await Tags.remove(req.params.id);
  await AuditLog.record(req.user.id, 'tag_removed', { name: tag.name });
  res.json({ ok: true });
}));

module.exports = router;

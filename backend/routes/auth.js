const express = require('express');
const router = express.Router();
const { Users, AuditLog } = require('../db/repo');
const { hashPassword, verifyPassword, issueToken, requireAuth } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');

// First-run setup: only allowed when there are zero users yet, creates the first Admin.
router.post('/setup', asyncHandler(async (req, res) => {
  const count = await Users.count();
  if (count > 0) return res.status(400).json({ error: 'Setup already completed. Ask an admin to invite you instead.' });
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
  const result = await Users.create(email, hashPassword(password), name, 'admin');
  const user = { id: result.insertId, email, name, role: 'admin' };
  await AuditLog.record(user.id, 'first_admin_created', { email });
  res.json({ token: issueToken(user), user });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await Users.findByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "That email or password doesn't match our records" });
  }
  await AuditLog.record(user.id, 'login', {});
  res.json({ token: issueToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));

// Admin/Manager invites a teammate.
router.post('/invite', requireAuth, asyncHandler(async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Only admins or managers can invite teammates' });
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
  const existing = await Users.findByEmail(email);
  if (existing) return res.status(400).json({ error: 'That email is already registered' });
  const result = await Users.create(email, hashPassword(password), name, role || 'sender');
  await AuditLog.record(req.user.id, 'invited_user', { email, role });
  res.json({ id: result.insertId, email, name, role: role || 'sender' });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.get('/team', requireAuth, asyncHandler(async (req, res) => res.json(await Users.list())));

module.exports = router;

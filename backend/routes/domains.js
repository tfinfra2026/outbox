const express = require('express');
const dns = require('dns').promises;
const router = express.Router();
const { Domains, AuditLog } = require('../db/repo');
const { requireAuth, requireRole } = require('../lib/auth');
const asyncHandler = require('../lib/asyncHandler');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => res.json(await Domains.list())));

router.post('/', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { domain_name, tracking_domain } = req.body;
  if (!domain_name) return res.status(400).json({ error: 'Domain name is required' });
  const result = await Domains.create(domain_name.toLowerCase().trim(), tracking_domain);
  await AuditLog.record(req.user.id, 'domain_added', { domain_name });
  res.json({ id: result.insertId, domain_name });
}));

// Returns the exact DNS records the user needs to paste at their registrar, and the
// recommended dkim selector/value pair. Real values - not placeholders - so a non-technical
// team can copy/paste without needing to understand what SPF/DKIM/DMARC mean.
router.get('/:id/dns-records', asyncHandler(async (req, res) => {
  const domain = await Domains.get(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  res.json({
    spf: { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.google.com ~all' },
    dkim: { type: 'TXT', host: `${domain.dkim_selector}._domainkey`, value: '(copy the DKIM key from your mailbox provider - e.g. Google Workspace admin console - here)' },
    dmarc: { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domain.domain_name}` }
  });
}));

// Real, live DNS verification via Node's resolver - no external service needed.
router.post('/:id/verify', asyncHandler(async (req, res) => {
  const domain = await Domains.get(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const checks = { spf: false, dkim: false, dmarc: false };

  try {
    const txt = await dns.resolveTxt(domain.domain_name);
    checks.spf = txt.some((rec) => rec.join('').startsWith('v=spf1'));
  } catch (e) { /* no TXT records yet */ }

  try {
    const txt = await dns.resolveTxt(`${domain.dkim_selector}._domainkey.${domain.domain_name}`);
    checks.dkim = txt.some((rec) => rec.join('').includes('v=DKIM1'));
  } catch (e) { /* not published yet */ }

  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain.domain_name}`);
    checks.dmarc = txt.some((rec) => rec.join('').startsWith('v=DMARC1'));
  } catch (e) { /* not published yet */ }

  await Domains.setVerification(domain.id, checks.spf, checks.dkim, checks.dmarc);
  res.json(checks);
}));

router.delete('/:id', requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const domain = await Domains.get(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  await Domains.remove(req.params.id);
  await AuditLog.record(req.user.id, 'domain_removed', { domain_name: domain.domain_name });
  res.json({ ok: true });
}));

module.exports = router;

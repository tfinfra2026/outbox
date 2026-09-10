const express = require('express');
const router = express.Router();
const { Templates, AuditLog, Settings, Prospects, Campaigns, Mailboxes, Sends } = require('../db/repo');
const { requireAuth } = require('../lib/auth');
const { htmlToPlainText, renderMergeTags, plainTextToHtml, makeToken, sendTemplateToProspect } = require('../lib/mailer');
const asyncHandler = require('../lib/asyncHandler');
const { decrypt } = require('../lib/crypto');
const { DEFAULT_MODEL, buildMessages, parseDraftResponse } = require('../lib/aiTemplates');

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => res.json(await Templates.list())));

router.get('/:id', asyncHandler(async (req, res) => {
  const t = await Templates.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
}));

function normalize(body) {
  const bodyText = body.type === 'html' && !body.body_text?.trim() ? htmlToPlainText(body.body_html) : body.body_text;
  return { ...body, body_text: bodyText };
}

// Preview text becomes the hidden inbox-preview snippet (see lib/mailer.js buildPreheaderHtml) -
// most inbox clients only ever display somewhere between 40 and 140 characters of it before
// truncating anyway, so anything much longer than this is wasted typing that the recipient would
// never actually see in full. Capped well short of that ceiling rather than right at it, since
// some clients (especially on mobile) show noticeably fewer characters than desktop Gmail/Outlook.
const PREVIEW_TEXT_MAX_LENGTH = 100;
function previewTextError(previewText) {
  if (previewText && previewText.trim().length > PREVIEW_TEXT_MAX_LENGTH) {
    return `Preview text must be ${PREVIEW_TEXT_MAX_LENGTH} characters or fewer`;
  }
  return null;
}

// Sends one real email through a real mailbox, using the exact same rendering pipeline as a
// live campaign send (merge tags, {{unsubscribe_link}}/{{company_address}}, click-tracking
// rewrite, footer logic) - so what lands in the inbox is exactly what a real recipient would
// get, not a separate best-effort preview. The subject is prefixed "[TEST]" so it's unmistakable
// in an inbox. Anchored to a single hidden system campaign (Campaigns.getOrCreateTestCampaign) so
// the send has a real campaign_prospects row - which is what makes its unsubscribe/open/click
// links genuinely functional if clicked, not just cosmetic. Never counts against any mailbox's
// daily cap (bypasses the scheduler/pickMailboxWithCapacity entirely) and never shows up on the
// real Campaigns page. The send itself isn't logged to the Activity feed, but if the test email
// is actually opened/clicked/unsubscribed afterward, that DOES show up there (grouped under
// "System - test sends (hidden)") - which is a feature, not a bug: it's your proof the tracking
// really works, not just that the email looked right.
router.post('/:id/send-test', asyncHandler(async (req, res) => {
  const template = await Templates.get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { to_email, first_name, last_name, company, mailbox_id } = req.body;
  const toEmail = (to_email || '').toLowerCase().trim();
  if (!toEmail || !toEmail.includes('@')) return res.status(400).json({ error: 'A valid "to" email is required' });
  if (!mailbox_id) return res.status(400).json({ error: 'A mailbox to send from is required' });

  const mailbox = await Mailboxes.get(mailbox_id);
  if (!mailbox) return res.status(400).json({ error: 'That mailbox no longer exists' });

  const settings = await Settings.all();
  const companyName = settings.company_name || process.env.COMPANY_NAME || 'Techforce Global';
  const companyAddress = settings.company_address || process.env.COMPANY_POSTAL_ADDRESS || '';
  const baseUrl = process.env.BASE_URL || 'http://localhost:4000';

  // The sample values typed into the test form - always what actually gets rendered into the
  // email, regardless of what's already on file for this email address.
  const sampleProspect = { first_name: first_name || 'Test', last_name: last_name || '', company: company || 'Test Company', email: toEmail };

  const testCampaign = await Campaigns.getOrCreateTestCampaign(req.user.id);
  // upsert (not create) - testing repeatedly with the same address reuses the same contact and
  // campaign_prospects row instead of piling up duplicates. Note: upsert() only fills in
  // first_name/company on the FIRST test for a given address - it deliberately doesn't overwrite
  // an existing contact's real details on repeat tests. That's fine here since the DB row is only
  // used as an FK anchor below; the email itself always renders sampleProspect's fresh values.
  const prospect = await Prospects.upsert(sampleProspect);
  const { rows: [cp] } = await Campaigns.addProspects(testCampaign.id, [prospect.id]);

  const token = makeToken();
  const testTemplate = { ...template, subject: `[TEST] ${template.subject || ''}` };
  await sendTemplateToProspect({
    mailbox,
    template: testTemplate,
    prospect: sampleProspect,
    token,
    baseUrl,
    companyName,
    companyAddress
  });
  await Sends.create(cp.id, mailbox.id, 1, token, null);

  await AuditLog.record(req.user.id, 'test_email_sent', { template_id: req.params.id, template_name: template.name, to_email: toEmail, mailbox_id });
  res.json({ ok: true, to_email: toEmail });
}));

// Drafts a template with AI (OpenRouter) from a short prompt - returns the draft only, never
// writes to the database. The frontend hands the draft to the normal "new template" editor flow
// so the user reviews/edits it before it's ever saved, same as any other template.
router.post('/generate-ai', asyncHandler(async (req, res) => {
  const { prompt, tone, length, type } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Describe what this email is for.' });

  const settings = await Settings.all();
  if (!settings.openrouter_api_key_encrypted) {
    return res.status(400).json({ error: 'Add an OpenRouter API key in Settings first.', needsApiKey: true });
  }

  let apiKey;
  try {
    apiKey = decrypt(settings.openrouter_api_key_encrypted);
  } catch (e) {
    return res.status(500).json({ error: 'The stored API key could not be read - re-enter it in Settings.' });
  }

  const model = settings.openrouter_model || DEFAULT_MODEL;
  const messages = buildMessages({ prompt, tone, length, type });

  // A short template draft never needs anywhere near a model's default max output (often
  // 16k+ tokens) - capping it keeps cost predictable and avoids OpenRouter's "requires more
  // credits" error on accounts with a small balance. HTML drafts need a much bigger allowance
  // than plain text though: every element gets its own inline style="..." attribute per the
  // instructions in aiTemplates.js, which easily runs to 2000+ tokens once escaped inside the
  // JSON response - a flat 1200-token cap was silently truncating those mid-JSON, which
  // JSON.parse then reported as a generic "could not read the AI response" failure.
  const maxTokens = type === 'html' ? 3000 : 1000;

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens })
    });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach OpenRouter - check your connection and try again." });
  }

  if (!response.ok) {
    // Surface OpenRouter's actual error text (logged server-side, and echoed back to the UI) -
    // a generic "couldn't generate" message was hiding exactly why (bad key, no credits, unknown
    // model, rate limit, etc), making this impossible to self-diagnose from the frontend alone.
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || (typeof errBody === 'string' ? errBody : JSON.stringify(errBody));
    } catch (e) { /* body wasn't JSON - fall through with no detail */ }
    console.error(`[templates/generate-ai] OpenRouter request failed: status=${response.status} model=${model} detail=${detail}`);

    let message;
    if (response.status === 401) {
      message = 'OpenRouter rejected the API key - check it in Settings.';
    } else if (response.status === 402) {
      message = 'OpenRouter says this account has no billing credits - add credits at openrouter.ai/settings/credits and try again.';
    } else if (response.status === 404) {
      message = `OpenRouter doesn't recognize the model "${model}" - pick a different one in Settings.`;
    } else if (response.status === 429) {
      message = 'OpenRouter rate-limited this request - wait a moment and try again.';
    } else {
      message = `OpenRouter couldn't generate a draft right now (${response.status}${detail ? ': ' + detail : ''}) - try again.`;
    }
    return res.status(502).json({ error: message });
  }

  const data = await response.json();
  const rawContent = data?.choices?.[0]?.message?.content;
  const finishReason = data?.choices?.[0]?.finish_reason;

  // If the model got cut off mid-response (hit max_tokens before finishing), the JSON will be
  // incomplete and JSON.parse below would otherwise report a vague "could not read the AI
  // response" - checking finish_reason first lets us say plainly that it was a length/token
  // limit, not some other parsing problem.
  if (finishReason === 'length') {
    console.error(`[templates/generate-ai] OpenRouter response was truncated: model=${model} type=${type} max_tokens=${maxTokens}`);
    return res.status(502).json({ error: 'The AI response was cut off before it finished (hit the token limit) - try regenerating, or use a shorter length.' });
  }

  let draft;
  try {
    draft = parseDraftResponse(rawContent, type);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  await AuditLog.record(req.user.id, 'template_ai_draft_generated', { model });
  res.json({ draft });
}));

router.post('/', asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.name.trim() || !req.body.subject) return res.status(400).json({ error: 'Name and subject are required' });
  const previewTextErr = previewTextError(req.body.preview_text);
  if (previewTextErr) return res.status(400).json({ error: previewTextErr });
  if (await Templates.findByName(req.body.name)) {
    return res.status(400).json({ error: `A template named "${req.body.name.trim()}" already exists` });
  }
  const payload = normalize(req.body);
  const result = await Templates.create(payload);
  await AuditLog.record(req.user.id, 'template_created', { name: req.body.name });
  res.json({ id: result.insertId });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) return res.status(400).json({ error: 'Name and subject are required' });
  const previewTextErr = previewTextError(req.body.preview_text);
  if (previewTextErr) return res.status(400).json({ error: previewTextErr });
  const existing = await Templates.findByName(req.body.name);
  if (existing && String(existing.id) !== String(req.params.id)) {
    return res.status(400).json({ error: `A template named "${req.body.name.trim()}" already exists` });
  }
  const payload = normalize(req.body);
  await Templates.update(req.params.id, payload);
  await AuditLog.record(req.user.id, 'template_updated', { id: req.params.id });
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const t = await Templates.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const stepsUsingIt = await Templates.countStepsUsing(req.params.id);
  if (stepsUsingIt > 0) {
    return res.status(400).json({
      error: `This template is used by ${stepsUsingIt} sequence step${stepsUsingIt === 1 ? '' : 's'} - remove or reassign ${stepsUsingIt === 1 ? 'it' : 'them'} first.`
    });
  }
  await Templates.remove(req.params.id);
  await AuditLog.record(req.user.id, 'template_removed', { name: t.name });
  res.json({ ok: true });
}));

// Live preview with sample prospect data, used by the template editor's preview pane.
router.post('/:id/preview', asyncHandler(async (req, res) => {
  const t = await Templates.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const sample = { first_name: 'Priya', last_name: 'Shah', company: 'Acme Corp', email: 'priya@acme.com' };
  const renderedHtml = renderMergeTags(t.body_html, sample);
  const text = renderMergeTags(t.body_text, sample);
  res.json({
    subject: renderMergeTags(t.subject, sample),
    html: renderedHtml && renderedHtml.trim() ? renderedHtml : plainTextToHtml(text),
    text
  });
}));

module.exports = router;

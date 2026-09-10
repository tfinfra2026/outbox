const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { decrypt } = require('./crypto');

function renderMergeTags(str, prospect) {
  if (!str) return '';
  const fields = {
    first_name: prospect.first_name || 'there',
    last_name: prospect.last_name || '',
    company: prospect.company || 'your company',
    email: prospect.email || ''
  };
  return str.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (fields[key] !== undefined ? fields[key] : match));
}

// The reverse of htmlToPlainText below - a small plain text -> HTML fallback, used when a
// template is Plain-text-only (body_html is genuinely empty by design - see TemplateEditor.jsx,
// which never touches body_html for a "text" type template). Without this, a plain-text
// template's outgoing HTML part would contain nothing but the tracking footer/pixel, since
// buildTrackedMessage builds fullHtml straight from body_html - most email clients render the
// HTML part by default, so the actual message would appear to be missing from the email body
// even though the plain-text alternative part was fine.
function plainTextToHtml(text) {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Very small HTML -> plain text fallback generator (strips tags, collapses whitespace).
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Builds the hidden "preheader" snippet email clients (Gmail, Outlook, Apple Mail) show next to
// the subject line in the inbox list, before the email is opened - this is the ONLY thing
// templates.preview_text is for. Previously that field was saved and shown in the editor but
// never actually reached the outgoing email, so it had zero real effect - a Gmail inbox would
// just fall back to showing whatever visible text happens to be first in the body instead.
//
// Two stacked hidden divs, the standard technique for this:
// 1. The real preview text, in a div hidden from rendering (display:none + max-height:0 +
//    overflow:hidden + mso-hide:all for Outlook's mso-specific hiding) but still present as the
//    first text node in the HTML - which is exactly what inbox clients scan for.
// 2. A block of invisible padding characters (a wide space + zero-width non-joiner, repeated)
//    long enough to exceed what any client's preview snippet will show. Without this, once the
//    client finishes reading the real preview text it keeps scanning into the next visible text
//    node (the actual email body) and tacks a fragment of that on the end of the preview too -
//    so this padding "uses up" the rest of the snippet's length on invisible characters instead.
function buildPreheaderHtml(previewText) {
  if (!previewText || !previewText.trim()) return '';
  const escaped = previewText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const hiddenStyle = 'display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;';
  const padding = '&#8199;&zwnj;'.repeat(120);
  return `<div style="${hiddenStyle}">${escaped}</div><div style="${hiddenStyle}">${padding}</div>`;
}

// Rewrites <a href="..."> links to go through /track/click/:token first, and appends
// the tracking pixel + compliance footer (unsubscribe link + postal address) required
// by CAN-SPAM/GDPR. Returns { html, text, token }.
//
// A template can instead place {{unsubscribe_link}} / {{company_address}} itself anywhere in
// its own body (see TemplateEditor.jsx's merge-tag helper text) for full control over how the
// unsubscribe link looks and where it sits, rather than getting the generic block below tacked
// on underneath. When a template does that, the auto-generated footer is skipped entirely -
// otherwise every send would end up with two unsubscribe links. Templates that don't use the
// tag keep getting this automatic footer as a compliance safety net, since CAN-SPAM/GDPR
// require a real unsubscribe link and postal address on every commercial email.
function buildTrackedMessage({ bodyHtml, bodyText, baseUrl, token, companyName, companyAddress, previewText }) {
  let html = bodyHtml || '';

  // Rewrite links for click tracking (skip the unsubscribe link itself, added separately below).
  // This MUST run before the {{unsubscribe_link}} substitution pass further down - at this point
  // a hand-placed {{unsubscribe_link}} tag is still literally that text, not a real https:// URL,
  // so this regex (which only matches existing href="http..." links) can't catch it. Doing the
  // substitution first would let a real unsubscribe link get wrapped in click tracking, which
  // would misreport someone unsubscribing as an engaged "click".
  html = html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
    const redirect = `${baseUrl}/track/click/${token}?u=${encodeURIComponent(url)}`;
    return `href="${redirect}"`;
  });

  const unsubscribeUrl = `${baseUrl}/unsubscribe/${token}`;
  const hasCustomUnsubscribe = /\{\{\s*unsubscribe_link\s*\}\}/.test(bodyHtml || '') || /\{\{\s*unsubscribe_link\s*\}\}/.test(bodyText || '');

  const footerHtml = hasCustomUnsubscribe ? '' : `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:12px;color:#888;">
      <p>${companyName} &middot; ${companyAddress}</p>
      <p>Don't want these emails? <a href="${unsubscribeUrl}">Unsubscribe here</a>.</p>
    </div>`;

  const pixel = `<img src="${baseUrl}/track/open/${token}.png" width="1" height="1" alt="" style="display:none;" />`;

  // Must be the very first thing in the HTML body - inbox clients read the preview snippet from
  // whatever text node comes first, so this has to sit ahead of the real message content, not
  // appended alongside the footer/pixel at the end.
  const preheader = buildPreheaderHtml(previewText);

  let fullHtml = `${preheader}${html}${footerHtml}${pixel}`;

  const plainBase = bodyText && bodyText.trim() ? bodyText : htmlToPlainText(bodyHtml);
  let fullText = hasCustomUnsubscribe ? plainBase : `${plainBase}\n\n--\n${companyName}\n${companyAddress}\nUnsubscribe: ${unsubscribeUrl}`;

  // Final substitution pass for the merge tags a template may have placed itself - runs last
  // (after the click-tracking rewrite above) specifically so the real unsubscribe URL is never
  // mistaken for a trackable outbound link. {{company_name}} joins {{company_address}} here -
  // previously only the address could be self-placed in a template's own body; the name
  // (Settings > company_name) was only ever inserted into the auto-generated default footer,
  // with no way for a template author to place it themselves, e.g. in a signature block.
  fullHtml = fullHtml
    .replace(/\{\{\s*unsubscribe_link\s*\}\}/g, unsubscribeUrl)
    .replace(/\{\{\s*company_name\s*\}\}/g, companyName || '')
    .replace(/\{\{\s*company_address\s*\}\}/g, companyAddress || '');
  fullText = fullText
    .replace(/\{\{\s*unsubscribe_link\s*\}\}/g, unsubscribeUrl)
    .replace(/\{\{\s*company_name\s*\}\}/g, companyName || '')
    .replace(/\{\{\s*company_address\s*\}\}/g, companyAddress || '');

  return { html: fullHtml, text: fullText };
}

function buildTransport(mailbox) {
  if (process.env.TEST_MODE === 'true') {
    // No real network send - captures the message as JSON, used only by automated smoke tests.
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port || 587,
    secure: mailbox.smtp_port === 465,
    auth: {
      user: mailbox.smtp_user,
      pass: decrypt(mailbox.smtp_pass_encrypted)
    }
  });
}

async function sendTemplateToProspect({ mailbox, template, prospect, token, baseUrl, companyName, companyAddress }) {
  const subject = renderMergeTags(template.subject, prospect);
  const renderedHtml = renderMergeTags(template.body_html, prospect);
  const bodyText = renderMergeTags(template.body_text, prospect);
  // Plain-text templates never populate body_html (by design - see TemplateEditor.jsx), so
  // fall back to a synthesized HTML version of the plain text rather than sending an HTML
  // part with no message body in it at all.
  const bodyHtml = renderedHtml && renderedHtml.trim() ? renderedHtml : plainTextToHtml(bodyText);
  // Preview text supports the same merge tags as the subject/body (e.g. "{{first_name}}, don't
  // miss this") - rendered here rather than left as literal template syntax in the inbox.
  const previewText = renderMergeTags(template.preview_text, prospect);

  const { html, text } = buildTrackedMessage({ bodyHtml, bodyText, baseUrl, token, companyName, companyAddress, previewText });

  const transport = buildTransport(mailbox);
  const info = await transport.sendMail({
    from: `"${template.sender_name || mailbox.display_name}" <${mailbox.email}>`,
    to: prospect.email,
    subject,
    html,
    text,
    replyTo: mailbox.email
  });
  return info;
}

module.exports = { renderMergeTags, htmlToPlainText, plainTextToHtml, makeToken, buildTrackedMessage, sendTemplateToProspect };

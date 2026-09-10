// Bounce capture for mailboxes that are NOT on Amazon SES (see routes/track.js's /webhook/ses
// for that path). A generic SMTP provider (Gmail, Outlook, a cPanel host, etc.) has no webhook
// at all - the only universal signal that a send failed is the bounce-back email (a DSN,
// Delivery Status Notification per RFC 3464) that lands in the mailbox's OWN inbox, the same way
// it would if a person had sent the email manually. This module polls that inbox via IMAP on a
// schedule (see server.js) and parses whatever DSNs it finds, feeding them into the exact same
// downstream pipeline (Sends.markBounced / Suppression.add / mailbox counters) the SES webhook
// uses - so a campaign's health looks the same regardless of which mailbox actually sent it.
//
// Deliberately scoped to BOUNCES only, not complaints. A spam complaint on a plain SMTP mailbox
// is only visible to the sender at all if they've separately enrolled in that specific mailbox
// provider's feedback-loop program (Gmail/Outlook/Yahoo each run their own, with their own
// signup process and report format) - that's a genuinely separate integration per provider, not
// something IMAP polling can surface on its own. See the conversation this was scoped from.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { decrypt } = require('./crypto');
const { Mailboxes, Sends, Suppression, CampaignProspects, Campaigns, ActivityLog } = require('../db/repo');

// A real DSN embeds one or more machine-readable per-recipient blocks (RFC 3464) with lines like
// "Final-Recipient: rfc822; someone@example.com" and a "Status: 5.1.1" / "Action: failed" code -
// mailparser folds that block straight into the plain-text body by default (no special option
// needed), so a single pass over the combined text picks up every recipient a multi-recipient
// DSN might list.
const RECIPIENT_LINE_RE = /(?:Final|Original)-Recipient:\s*rfc822;\s*([^\s<>,;]+@[^\s<>,;]+)/gi;

// Fallback patterns for older/simpler mail servers that only send a human-readable paragraph,
// with no structured delivery-status block at all - best-effort, used only when the pattern
// above finds nothing.
const RECIPIENT_FALLBACK_PATTERNS = [
  /The following address(?:es)? (?:had|failed)[\s\S]{0,300}?<?([^\s<>,;]+@[^\s<>,;]+)>?/i,
  /delivery to the following recipient(?:s)? failed[\s\S]{0,300}?<?([^\s<>,;]+@[^\s<>,;]+)>?/i,
  /Your message to <?([^\s<>,;]+@[^\s<>,;]+)>? (?:could not be delivered|was not delivered)/i
];

// Enhanced status codes (RFC 3463) are the most reliable signal when present: 5.x.x is a
// permanent failure, 4.x.x is temporary. Falls back to keyword hints for servers that omit them.
function classifyBounceType(windowText) {
  if (/Status:\s*5\.\d/i.test(windowText)) return 'hard';
  if (/Status:\s*4\.\d/i.test(windowText)) return 'soft';
  return /permanent|does not exist|no such user|user unknown|mailbox not found|address rejected|550/i.test(windowText) ? 'hard' : 'soft';
}

// Returns [{ email, type }] parsed from one raw bounce email (Buffer/string). type is
// 'hard' | 'soft'. A single DSN can list more than one failed recipient, though in this app's
// sending model (one email per recipient per send) that's rare in practice - handled anyway.
async function parseDsn(rawMessage) {
  const parsed = await simpleParser(rawMessage);
  const bodyText = parsed.text || '';
  const results = [];
  const seen = new Set();

  let match;
  RECIPIENT_LINE_RE.lastIndex = 0;
  while ((match = RECIPIENT_LINE_RE.exec(bodyText))) {
    const email = match[1].toLowerCase().trim().replace(/[.,;]+$/, '');
    if (seen.has(email)) continue;
    seen.add(email);
    // Each recipient's own Status/Action fields sit in the same block right after its
    // Final-Recipient line - a window of the next ~500 chars is enough to catch them without
    // accidentally picking up a neighboring recipient's status in a multi-recipient DSN.
    const windowText = bodyText.slice(match.index, match.index + 500);
    results.push({ email, type: classifyBounceType(windowText) });
  }

  if (results.length === 0) {
    for (const pattern of RECIPIENT_FALLBACK_PATTERNS) {
      const m = bodyText.match(pattern);
      if (m) {
        results.push({ email: m[1].toLowerCase().trim().replace(/[.,;]+$/, ''), type: classifyBounceType(bodyText) });
        break;
      }
    }
  }

  return results;
}

// A bounce-back is easy to mistake for a real reply if judged on subject alone - this checks the
// handful of signals real mail servers actually use (sender address, standard subject phrasing),
// so a normal reply from an actual person is never misread as a bounce.
function looksLikeBounce(parsedEnvelope) {
  const from = ((parsedEnvelope.from && parsedEnvelope.from.value && parsedEnvelope.from.value[0] && parsedEnvelope.from.value[0].address) || '').toLowerCase();
  const subject = (parsedEnvelope.subject || '').toLowerCase();
  if (from.startsWith('mailer-daemon') || from.startsWith('postmaster')) return true;
  return /undeliver|delivery status notification|delivery has failed|mail delivery failed|returned to sender/i.test(subject);
}

// Same effect as the SES webhook's per-recipient handling in routes/track.js, kept as its own
// function so both paths stay in sync if that pipeline ever changes.
async function processBounceEmail(email, type) {
  const send = await Sends.findMostRecentUnbouncedByEmail(email);
  if (!send) return false;
  await Sends.markBounced(send.tracking_token, type);
  await ActivityLog.recordEngagement(send, 'bounced', type);
  await Mailboxes.incrementBounce(send.mailbox_id);
  if (type === 'hard') {
    const cp = await CampaignProspects.get(send.campaign_prospect_id);
    const campaign = cp ? await Campaigns.get(cp.campaign_id) : null;
    await Suppression.add(email, 'bounced', campaign ? campaign.name : null);
  }
  return true;
}

// Connects to one mailbox's own inbox, scans only unseen messages (IMAP's \Seen flag is the
// entire "already handled" bookkeeping - no separate column/table needed to track what's been
// processed), parses any that look like a bounce, and marks every message it looked at as seen
// once done - including ones that turned out not to be bounces, so a normal reply doesn't get
// rescanned on every future poll.
async function pollMailboxForBounces(mailbox) {
  if (!mailbox.imap_host || !mailbox.imap_user || !mailbox.imap_pass_encrypted) {
    console.warn(`[bounce capture] mailbox ${mailbox.email} is set to IMAP capture but is missing IMAP connection details - skipping`);
    return { checked: 0, bounced: 0 };
  }

  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port || 993,
    secure: true,
    auth: { user: mailbox.imap_user, pass: decrypt(mailbox.imap_pass_encrypted) },
    logger: false
  });

  let checked = 0;
  let bounced = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids) {
        checked += 1;
        const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!message || !message.source) continue;

        const parsedEnvelope = await simpleParser(message.source);
        if (looksLikeBounce(parsedEnvelope)) {
          const recipients = await parseDsn(message.source);
          for (const { email, type } of recipients) {
            const handled = await processBounceEmail(email, type);
            if (!handled) console.warn(`[bounce capture] ${mailbox.email}: received a bounce for ${email} but found no matching send record`);
            else bounced += 1;
          }
        }
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error(`[bounce capture] failed polling ${mailbox.email}:`, err.message);
  }
  return { checked, bounced };
}

// Called on a schedule (see server.js) - only ever touches mailboxes explicitly set to IMAP
// capture; SES-configured and unconfigured ('none') mailboxes are left alone here entirely.
async function pollAllImapMailboxes() {
  const mailboxes = await Mailboxes.list();
  const imapMailboxes = mailboxes.filter((m) => m.bounce_capture_method === 'imap' && m.status !== 'paused');
  const results = [];
  for (const mailbox of imapMailboxes) {
    results.push({ mailbox: mailbox.email, ...(await pollMailboxForBounces(mailbox)) });
  }
  return results;
}

module.exports = { parseDsn, classifyBounceType, looksLikeBounce, processBounceEmail, pollMailboxForBounces, pollAllImapMailboxes };

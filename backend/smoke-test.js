// Automated verification harness. Exercises the real code paths end to end against a
// throwaway SQLite database and TEST_MODE mailer (no real emails leave the machine).
// Run with: npm run test:smoke
process.env.DB_DRIVER = 'sqlite';
process.env.TEST_MODE = 'true';
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.CREDENTIAL_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.SEND_ONLY_WEEKDAYS = 'false';
process.env.MIN_HOURS_BETWEEN_EMAILS_TO_SAME_PROSPECT = '72';
// Keep the randomized inter-send delay near-zero so the automated suite runs in seconds -
// in production these come from .env and default to a realistic 45-180s human-like pace.
process.env.MIN_SECONDS_BETWEEN_SENDS = '0';
process.env.MAX_SECONDS_BETWEEN_SENDS = '0.1';

const fs = require('fs');
const os = require('os');
const path = require('path');
// Uses the OS tmp dir rather than a project folder - some mounted/synced project folders
// don't support the file locking SQLite needs, which surfaces as a misleading "disk I/O error".
const testDbPath = path.join(os.tmpdir(), 'techforce-smoke-test.sqlite');
try { fs.unlinkSync(testDbPath); } catch (e) {}
try { fs.unlinkSync(testDbPath + '-wal'); } catch (e) {}
try { fs.unlinkSync(testDbPath + '-shm'); } catch (e) {}

const sqliteDriver = require('./db/sqlite-driver');
sqliteDriver.init(testDbPath);
require('./db/index').init = async () => {}; // already initialized above with the test path

const { Users, Domains, Mailboxes, Templates, Prospects, Campaigns, Sends, CampaignProspects, Suppression, Settings, AuditLog, ActivityLog, Tags, Lists, Analytics } = require('./db/repo');
const dbIndex = require('./db/index');
const { encrypt } = require('./lib/crypto');
const { hashPassword, verifyPassword, issueToken } = require('./lib/auth');
const { renderMergeTags, htmlToPlainText, plainTextToHtml, buildTrackedMessage, sendTemplateToProspect } = require('./lib/mailer');
const { safeCapForToday, warmupStatus } = require('./lib/warmup');
const scheduler = require('./lib/scheduler');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
}

async function main() {
  await Settings.set('company_name', 'Techforce Global');
  await Settings.set('company_address', '123 Business Park, Bengaluru, India');

  // The sending guardrails now live in the settings table (seeded with real-world defaults by
  // db/sqlite-driver.js on init) and take priority over process.env in lib/scheduler.js - so the
  // fast test values set via process.env above (SEND_ONLY_WEEKDAYS, MIN/MAX_SECONDS_BETWEEN_SENDS)
  // must also be mirrored into settings, or the scheduler would use the real 45-180s pace here
  // and this suite would take minutes instead of seconds.
  await Settings.set('send_only_weekdays', 'false');
  await Settings.set('min_hours_between_emails_to_same_prospect', '72');
  await Settings.set('min_seconds_between_sends', '0');
  await Settings.set('max_seconds_between_sends', '0.1');

  // --- Auth ---
  const passHash = hashPassword('Sup3rSecret!');
  check('password hash does not store plaintext', !passHash.includes('Sup3rSecret'));
  check('correct password verifies', verifyPassword('Sup3rSecret!', passHash) === true);
  check('wrong password rejected', verifyPassword('wrong', passHash) === false);
  const userResult = await Users.create('admin@techforceglobal.com', passHash, 'Bhavin Shah', 'admin');
  const user = await Users.findById(userResult.insertId);
  const token = issueToken(user);
  check('JWT issued', typeof token === 'string' && token.split('.').length === 3);

  // --- Credential encryption ---
  const encrypted = encrypt('my-smtp-app-password');
  const { decrypt } = require('./lib/crypto');
  check('encrypted credential is not plaintext', !encrypted.includes('my-smtp-app-password'));
  check('credential decrypts back correctly', decrypt(encrypted) === 'my-smtp-app-password');

  // --- Domain + mailbox setup ---
  const domainResult = await Domains.create('kabilhirehq.com', 'click.kabilhirehq.com');
  const mailboxResult = await Mailboxes.create({
    domain_id: domainResult.insertId,
    email: 'raj@kabilhirehq.com',
    display_name: 'KabilHire Talent Team',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_user: 'raj@kabilhirehq.com',
    smtp_pass_encrypted: encrypted,
    daily_cap: 50
  });
  let mailbox = await Mailboxes.get(mailboxResult.insertId);
  check('mailbox created with warming status', mailbox.status === 'warming');

  // --- Warmup ramp math ---
  const capDay0 = safeCapForToday(mailbox);
  check('day 0 warmup cap equals start cap', capDay0 === mailbox.warmup_start_cap, `cap=${capDay0}`);
  const rampedMailbox = { ...mailbox, warmup_start_date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) };
  check('fully ramped mailbox reaches full daily cap', safeCapForToday(rampedMailbox) === rampedMailbox.daily_cap);
  check('warmupStatus reports "active" once ramp complete', warmupStatus(rampedMailbox) === 'active');

  // --- Mailbox cap updates (skip/adjust warmup after creation) ---
  await Mailboxes.updateCaps(mailbox.id, { daily_cap: 40, warmup_start_cap: 40, warmup_ramp_days: 21 });
  const cappedMailbox = await Mailboxes.get(mailbox.id);
  check('updateCaps persists new daily_cap', cappedMailbox.daily_cap === 40, `daily_cap=${cappedMailbox.daily_cap}`);
  check('updateCaps persists new warmup_start_cap', cappedMailbox.warmup_start_cap === 40, `warmup_start_cap=${cappedMailbox.warmup_start_cap}`);
  check('raising warmup_start_cap to daily_cap removes the ramp throttle on day 0', safeCapForToday({ ...cappedMailbox, warmup_start_date: new Date().toISOString().slice(0, 10) }) === 40);

  // --- Mailbox details editing (identity/connection fields, without forcing a recreate) ---
  await Mailboxes.updateDetails(mailbox.id, {
    domain_id: cappedMailbox.domain_id,
    email: cappedMailbox.email,
    display_name: 'KabilHire Talent Team (Renamed)',
    smtp_host: 'smtp-relay.brevo.com',
    smtp_port: 587,
    smtp_user: cappedMailbox.smtp_user,
    smtp_pass_encrypted: cappedMailbox.smtp_pass_encrypted // password left untouched
  });
  const renamedMailbox = await Mailboxes.get(mailbox.id);
  check('updateDetails persists a new display name', renamedMailbox.display_name === 'KabilHire Talent Team (Renamed)');
  check('updateDetails persists a new SMTP host', renamedMailbox.smtp_host === 'smtp-relay.brevo.com');
  check('updateDetails leaves the encrypted password untouched when not changing it', renamedMailbox.smtp_pass_encrypted === cappedMailbox.smtp_pass_encrypted);

  // Use the fully-ramped mailbox for the rest of the test so sends aren't capacity-blocked.
  await require('./db/index').run('UPDATE mailboxes SET warmup_start_date=?, status=? WHERE id=?', [rampedMailbox.warmup_start_date, 'active', mailbox.id]);
  mailbox = await Mailboxes.get(mailbox.id);

  // --- Templates: merge tags + HTML->plaintext fallback ---
  const rendered = renderMergeTags('Hi {{first_name}} from {{company}}', { first_name: 'Priya', company: 'Acme' });
  check('merge tags render correctly', rendered === 'Hi Priya from Acme', rendered);
  const plain = htmlToPlainText('<p>Hello</p><p>World</p>');
  check('HTML to plain text fallback strips tags', plain === 'Hello\n\nWorld', JSON.stringify(plain));

  const templateResult = await Templates.create({
    name: 'Initial outreach', type: 'html', folder: 'Cold outreach',
    sender_name: 'KabilHire Talent Team', subject: 'Quick question, {{first_name}}',
    preview_text: 'A faster way to get hired', body_html: '<p>Hi {{first_name}}, quick note about {{company}}. <a href="https://kabilhire.in/apply">Apply here</a></p>', body_text: '', status: 'active'
  });
  const followupResult = await Templates.create({
    name: 'Follow-up 1', type: 'text', folder: 'Cold outreach',
    sender_name: 'KabilHire Talent Team', subject: 'Following up, {{first_name}}',
    preview_text: '', body_html: '', body_text: 'Hi {{first_name}}, just following up.', status: 'active'
  });

  // --- Template deletion (blocked while in use, allowed once free) ---
  const unusedTemplate = await Templates.create({
    name: 'Unused draft', type: 'text', folder: 'General',
    sender_name: '', subject: 'Draft subject', preview_text: '', body_html: '', body_text: 'Draft body', status: 'draft'
  });
  check('a template with zero sequence steps reports a usage count of 0', (await Templates.countStepsUsing(unusedTemplate.insertId)) === 0);
  await Templates.remove(unusedTemplate.insertId);
  check('an unused template can be deleted', !(await Templates.get(unusedTemplate.insertId)));

  // --- Compliance footer / tracking link rewrite ---
  const msg = buildTrackedMessage({
    bodyHtml: '<p>Hi <a href="https://kabilhire.in/apply">Apply</a></p>', bodyText: '',
    baseUrl: 'http://localhost:4000', token: 'abc123',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  check('outbound links rewritten through /track/click/', msg.html.includes('/track/click/abc123?u='));
  check('open pixel injected', msg.html.includes('/track/open/abc123.png'));
  check('unsubscribe link present in HTML', msg.html.includes('/unsubscribe/abc123'));
  check('unsubscribe link present in plain text', msg.text.includes('/unsubscribe/abc123'));
  check('postal address present (CAN-SPAM requirement)', msg.html.includes('123 Business Park'));

  // --- Self-placed {{unsubscribe_link}} / {{company_address}} merge tags - lets a template
  // author position and style the unsubscribe link themselves instead of getting the generic
  // footer block appended underneath. The default footer must disappear entirely once a
  // template takes over unsubscribe placement itself, and the real link must never get
  // wrapped in click tracking (that would misreport an unsubscribe as an engaged "click"). ---
  const customUnsubMsg = buildTrackedMessage({
    bodyHtml: '<p>Hi there. <a href="https://kabilhire.in/apply">Apply here</a></p><footer>© {{company_name}} · <a href="{{unsubscribe_link}}">Unsubscribe</a> · {{company_address}}</footer>',
    bodyText: '',
    baseUrl: 'http://localhost:4000', token: 'customtoken1',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  check(
    'a self-placed {{unsubscribe_link}} tag is replaced with the real unsubscribe URL',
    customUnsubMsg.html.includes('href="http://localhost:4000/unsubscribe/customtoken1"'),
    customUnsubMsg.html
  );
  check(
    'the self-placed unsubscribe link is NOT wrapped in click tracking (unsubscribing must never count as an engaged click)',
    !customUnsubMsg.html.includes(`/track/click/customtoken1?u=${encodeURIComponent('http://localhost:4000/unsubscribe/customtoken1')}`),
    customUnsubMsg.html
  );
  check('a real outbound link elsewhere in the same email is still click-tracked as normal', customUnsubMsg.html.includes('/track/click/customtoken1?u='), customUnsubMsg.html);
  check('{{company_address}} is substituted with the real address', customUnsubMsg.html.includes('123 Business Park, Bengaluru'), customUnsubMsg.html);
  check('{{company_name}} is substituted with the real company name when self-placed in a template', customUnsubMsg.html.includes('© Techforce Global'), customUnsubMsg.html);
  check('the default footer block is NOT appended when a template supplies its own unsubscribe link', !customUnsubMsg.html.includes("Don't want these emails?"), customUnsubMsg.html);
  check('the open tracking pixel is still injected even with a custom unsubscribe link', customUnsubMsg.html.includes('/track/open/customtoken1.png'));
  check(
    'the plain-text part has no auto-appended footer/signature once the template supplies its own unsubscribe tag',
    !customUnsubMsg.text.includes('Unsubscribe: http') && !customUnsubMsg.text.includes('\n\n--\n'),
    customUnsubMsg.text
  );
  check('{{company_address}} is still substituted in the plain-text part too', customUnsubMsg.text.includes('123 Business Park, Bengaluru'), customUnsubMsg.text);

  const defaultFooterMsg = buildTrackedMessage({
    bodyHtml: '<p>Hi there, no custom tag here.</p>', bodyText: '',
    baseUrl: 'http://localhost:4000', token: 'defaulttoken1',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  check(
    'a template with no {{unsubscribe_link}} tag still gets the automatic default footer (compliance safety net)',
    defaultFooterMsg.html.includes("Don't want these emails?") && defaultFooterMsg.html.includes('/unsubscribe/defaulttoken1'),
    defaultFooterMsg.html
  );

  // --- Hidden system campaign backing "Send test email" (routes/templates.js POST /:id/send-test) ---
  const testCampaignFirst = await Campaigns.getOrCreateTestCampaign(user.id);
  check('getOrCreateTestCampaign creates a real campaign row', !!testCampaignFirst && !!testCampaignFirst.id, JSON.stringify(testCampaignFirst));
  check('the hidden test campaign is created paused, so the scheduler never touches it', testCampaignFirst.status === 'paused', JSON.stringify(testCampaignFirst));
  const testCampaignSecond = await Campaigns.getOrCreateTestCampaign(user.id);
  check('calling getOrCreateTestCampaign again reuses the same campaign instead of creating a second one', testCampaignSecond.id === testCampaignFirst.id, `${testCampaignSecond.id} vs ${testCampaignFirst.id}`);
  const visibleCampaigns = await Campaigns.list();
  check('the hidden test campaign never appears in the real Campaigns list', !visibleCampaigns.some((c) => c.id === testCampaignFirst.id), JSON.stringify(visibleCampaigns.map((c) => c.id)));

  // --- Regression: a Plain-text-only template's outgoing HTML must contain the actual message,
  // not just the tracking footer. body_html is genuinely empty for a "text" type template (the
  // editor never touches it), so sendTemplateToProspect must fall back to a synthesized HTML
  // rendering of body_text - without this fallback, buildTrackedMessage builds the HTML part
  // straight from the (empty) body_html, and most email clients render the HTML part by
  // default, making the message appear to have no body at all even though it sent successfully. ---
  check('plainTextToHtml converts a plain-text body into paragraphs', plainTextToHtml('Hello there\n\nSecond paragraph.') === '<p>Hello there</p>\n<p>Second paragraph.</p>', plainTextToHtml('Hello there\n\nSecond paragraph.'));
  const plainOnlyTemplateResult = await Templates.create({
    name: 'Plain-only body regression test', type: 'text', folder: 'General',
    sender_name: 'Tester', subject: 'Body content check',
    preview_text: '', body_html: '', body_text: 'Hello {{first_name}}\n\nThis is the real message body.', status: 'active'
  });
  const plainOnlyTemplate = await Templates.get(plainOnlyTemplateResult.insertId);
  const plainOnlySendInfo = await sendTemplateToProspect({
    mailbox, template: plainOnlyTemplate, prospect: { first_name: 'Aditi', last_name: '', company: '', email: 'aditi@example.com' },
    token: 'bodyregressiontest', baseUrl: 'http://localhost:4000',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  const plainOnlySentMsg = JSON.parse(plainOnlySendInfo.message);
  check('a plain-text template\'s sent HTML contains the actual message body', plainOnlySentMsg.html.includes('This is the real message body.'), plainOnlySentMsg.html);
  check('a plain-text template\'s sent HTML still renders merge tags', plainOnlySentMsg.html.includes('Hello Aditi'), plainOnlySentMsg.html);

  // --- Preview text (inbox preheader) - previously saved to the DB and shown in the editor but
  // never actually reaching the outgoing email at all. This confirms it now does, rendered
  // through merge tags, sitting ahead of the real body so it's genuinely the first text node an
  // inbox client would read, and followed by invisible padding so the client doesn't also grab a
  // fragment of the real body onto the end of the preview snippet. ---
  const previewMsg = buildTrackedMessage({
    bodyHtml: '<p>This is the real message body, not the preview.</p>', bodyText: '',
    baseUrl: 'http://localhost:4000', token: 'previewtoken1',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru',
    previewText: 'A faster way to get hired'
  });
  check('preview text appears in the sent HTML', previewMsg.html.includes('A faster way to get hired'), previewMsg.html);
  check(
    'preview text is hidden from actual rendering (display:none)',
    /<div style="[^"]*display:none[^"]*">A faster way to get hired<\/div>/.test(previewMsg.html),
    previewMsg.html
  );
  check(
    'the preview text sits ahead of the real body content, not appended after it',
    previewMsg.html.indexOf('A faster way to get hired') < previewMsg.html.indexOf('This is the real message body'),
    previewMsg.html
  );
  check('invisible padding follows the preview text so the client can\'t bleed real body text into the snippet', previewMsg.html.includes('&zwnj;'), previewMsg.html);

  const noPreviewMsg = buildTrackedMessage({
    bodyHtml: '<p>No preview text on this one.</p>', bodyText: '',
    baseUrl: 'http://localhost:4000', token: 'previewtoken2',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  check('no preheader markup is added when a template has no preview text', !noPreviewMsg.html.includes('mso-hide'), noPreviewMsg.html);

  const previewTemplateResult = await Templates.create({
    name: 'Preview text merge-tag test', type: 'text', folder: 'General',
    sender_name: 'Tester', subject: 'Hello',
    preview_text: '{{first_name}}, a faster way to get hired', body_html: '', body_text: 'Body here.', status: 'active'
  });
  const previewTemplate = await Templates.get(previewTemplateResult.insertId);
  const previewSendInfo = await sendTemplateToProspect({
    mailbox, template: previewTemplate, prospect: { first_name: 'Rahul', last_name: '', company: '', email: 'rahul-preview@example.com' },
    token: 'previewmergetagtest', baseUrl: 'http://localhost:4000',
    companyName: 'Techforce Global', companyAddress: '123 Business Park, Bengaluru'
  });
  const previewSentMsg = JSON.parse(previewSendInfo.message);
  check('preview text renders merge tags in a real send, same as subject/body', previewSentMsg.html.includes('Rahul, a faster way to get hired'), previewSentMsg.html);

  // --- Campaign + sequence with per-step configurable wait + engagement skip ---
  const campaignResult = await Campaigns.create('Kabilhire - SaaS founders', 'pool', user.id);
  await Campaigns.assignMailbox(campaignResult.insertId, mailbox.id);
  await Campaigns.addStep(campaignResult.insertId, 1, templateResult.insertId, 0, false); // due immediately
  await Campaigns.addStep(campaignResult.insertId, 2, followupResult.insertId, 3, true); // skip if engaged
  await Campaigns.setStatus(campaignResult.insertId, 'active');

  check('a template used by a sequence step reports a non-zero usage count', (await Templates.countStepsUsing(templateResult.insertId)) === 1);
  check('countStepsUsing counts steps across every campaign referencing the template, not just one', (await Templates.countStepsUsing(followupResult.insertId)) === 1);

  const prospectA = await Prospects.upsert({ email: 'founder.a@example.com', first_name: 'Aditi', company: 'Example Inc' });
  const prospectB = await Prospects.upsert({ email: 'founder.b@example.com', first_name: 'Rahul', company: 'Beta Labs' });
  await Campaigns.addProspects(campaignResult.insertId, [prospectA.id, prospectB.id]);

  // --- Suppression must block sending entirely ---
  await Suppression.add('founder.b@example.com', 'manual');
  await require('./db/index').run('UPDATE prospects SET is_suppressed=1 WHERE email=?', ['founder.b@example.com']);

  const firstRun = await scheduler.runOnce({ ignoreWindow: true });
  check('scheduler processed both due prospects', firstRun.processed === 2, `processed=${firstRun.processed}`);
  check('scheduler sent to the non-suppressed prospect', firstRun.sent === 1, `sent=${firstRun.sent}`);
  const suppressedDetail = firstRun.details.find((d) => d.email === 'founder.b@example.com');
  check('suppressed prospect was skipped, not sent', suppressedDetail && suppressedDetail.reason === 'suppressed');

  // --- Live activity feed: every real send/skip in the run above should have logged a row,
  // with enough denormalized context (campaign name, prospect email, mailbox) to render
  // directly in the terminal-style log screen without any joins at read time. ---
  const activityAfterFirstRun = await ActivityLog.list({ limit: 50 });
  const sentActivity = activityAfterFirstRun.find((a) => a.event_type === 'sent' && a.prospect_email === 'founder.a@example.com');
  check('a "sent" activity row was logged for the non-suppressed prospect', !!sentActivity, JSON.stringify(sentActivity));
  check('the "sent" row carries the campaign name', sentActivity && sentActivity.campaign_name === 'Kabilhire - SaaS founders', JSON.stringify(sentActivity));
  check('the "sent" row carries the sending mailbox\'s email', sentActivity && sentActivity.mailbox_email === mailbox.email, JSON.stringify(sentActivity));
  check('the "sent" row carries the step order', sentActivity && sentActivity.step_order === 1, JSON.stringify(sentActivity));

  const skippedActivity = activityAfterFirstRun.find((a) => a.event_type === 'skipped' && a.prospect_email === 'founder.b@example.com');
  check('a "skipped" activity row was logged for the suppressed prospect', !!skippedActivity, JSON.stringify(skippedActivity));
  check('the "skipped" row records the reason', skippedActivity && skippedActivity.reason === 'suppressed', JSON.stringify(skippedActivity));

  mailbox = await Mailboxes.get(mailbox.id);
  check('mailbox sent_today incremented after send', mailbox.sent_today === 1, `sent_today=${mailbox.sent_today}`);

  // --- Per-step send activity (powers the richer timeline: sending time + delay to next step) ---
  const activity = await Campaigns.stepActivity(campaignResult.insertId);
  const step1Activity = activity.find((a) => a.step_order === 1);
  const step2Activity = activity.find((a) => a.step_order === 2);
  check('stepActivity reports one send for step 1', step1Activity && step1Activity.sent_count === 1, JSON.stringify(step1Activity));
  check('stepActivity records a last_sent_at timestamp for step 1', !!step1Activity.last_sent_at);
  check('stepActivity reports zero sends for step 2 (not reached yet)', step2Activity && step2Activity.sent_count === 0);

  const sendsRows = await require('./db/index').query('SELECT * FROM sends');
  check('a send row was recorded with a tracking token', sendsRows.length === 1 && sendsRows[0].tracking_token.length > 10);

  // --- Global minimum-gap enforcement: running again immediately must not double-send ---
  const secondRunSameProspect = await scheduler.runOnce({ ignoreWindow: true });
  check('no immediate re-send within the minimum gap window', secondRunSameProspect.sent === 0, `sent=${secondRunSameProspect.sent}`);

  // --- Regression: pausing a campaign mid-tick must stop its still-queued sends, not just
  // future ticks. runOnce() fetches its due list ONCE per tick, then processes it one at a time
  // with a real pacing delay between sends - a real "I paused it and it kept sending anyway"
  // report traced back to processOneDueProspect never re-checking the campaign's live status
  // after that initial fetch. Simulated here exactly as it happens for real: fetch the due
  // snapshot while still active, pause AFTER that snapshot is taken, then process the
  // already-stale snapshot and confirm it's skipped rather than sent. ---
  const raceCampaign = await Campaigns.create('Race pause test', 'pool', user.id);
  await Campaigns.assignMailbox(raceCampaign.insertId, mailbox.id);
  await Campaigns.addStep(raceCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(raceCampaign.insertId, 'active');
  const raceProspect = await Prospects.upsert({ email: 'race.pause.test@example.com', first_name: 'Race' });
  await Campaigns.addProspects(raceCampaign.insertId, [raceProspect.id]);

  const raceDueBatch = await CampaignProspects.listDue(require('./lib/dates').toSqlDatetime());
  const raceCp = raceDueBatch.find((d) => d.email === 'race.pause.test@example.com');
  check('the due prospect was captured in the batch while the campaign was still active', !!raceCp, JSON.stringify(raceCp));

  await Campaigns.setStatus(raceCampaign.insertId, 'paused');

  const raceResult = await scheduler.processOneDueProspect(raceCp, {
    baseUrl: 'http://localhost:4000', companyName: 'Techforce Global', companyAddress: '', settings: {}
  });
  check(
    'a prospect from a since-paused campaign is skipped, not sent, even from an already-fetched batch',
    raceResult.sent === false && raceResult.reason === 'campaign_not_active',
    JSON.stringify(raceResult)
  );

  const raceSends = await require('./db/index').query('SELECT * FROM sends WHERE campaign_prospect_id = ?', [raceCp.id]);
  check('no send row was created for the paused campaign\'s stale-batch prospect', raceSends.length === 0, `sends=${raceSends.length}`);

  const raceSkipActivity = (await ActivityLog.list({ limit: 50 })).find((a) => a.event_type === 'skipped' && a.prospect_email === 'race.pause.test@example.com');
  check('a "skipped" activity row with reason campaign_not_active was logged', raceSkipActivity && raceSkipActivity.reason === 'campaign_not_active', JSON.stringify(raceSkipActivity));

  // --- SCHEDULER_BATCH_SIZE: a single tick must not swallow more due prospects than the
  // configured batch limit, even when more are due right now - the whole point (see
  // lib/scheduler.js's batchSize comment) is keeping each tick short, so a huge backlog on one
  // campaign can never make a newly-activated campaign invisible to the scheduler for hours.
  // Whatever's left over must still get picked up on the very next tick (next_due_at is
  // untouched), not lost or silently dropped. Checked against this batch's own emails, not the
  // run's raw `processed` count, so this stays correct regardless of whatever else might still
  // be due from earlier tests in this file. ---
  const batchCampaign = await Campaigns.create('Batch limit test', 'pool', user.id);
  await Campaigns.assignMailbox(batchCampaign.insertId, mailbox.id);
  await Campaigns.addStep(batchCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(batchCampaign.insertId, 'active');
  const batchProspects = await Promise.all(
    ['batch1@example.com', 'batch2@example.com', 'batch3@example.com', 'batch4@example.com', 'batch5@example.com']
      .map((email) => Prospects.upsert({ email, first_name: 'Batch' }))
  );
  await Campaigns.addProspects(batchCampaign.insertId, batchProspects.map((p) => p.id));

  const batchEmails = batchProspects.map((p) => p.email);
  const countBatchDetails = (run) => run.details.filter((d) => batchEmails.includes(d.email)).length;

  process.env.SCHEDULER_BATCH_SIZE = '2';
  const batchRun1 = await scheduler.runOnce({ ignoreWindow: true });
  check(
    'a tick only takes up to SCHEDULER_BATCH_SIZE due prospects from a larger backlog',
    countBatchDetails(batchRun1) === 2,
    `count=${countBatchDetails(batchRun1)}`
  );

  const batchRun2 = await scheduler.runOnce({ ignoreWindow: true });
  check(
    'leftover due prospects from a capped tick are picked up on the very next tick, not lost',
    countBatchDetails(batchRun2) === 2,
    `count=${countBatchDetails(batchRun2)}`
  );

  const batchRun3 = await scheduler.runOnce({ ignoreWindow: true });
  check(
    'the last remaining due prospect is picked up once the backlog drains below the batch size',
    countBatchDetails(batchRun3) === 1,
    `count=${countBatchDetails(batchRun3)}`
  );

  const totalBatchSent = [batchRun1, batchRun2, batchRun3]
    .reduce((sum, r) => sum + r.details.filter((d) => batchEmails.includes(d.email) && d.sent).length, 0);
  check('all 5 batched prospects were eventually sent across the 3 capped ticks - none lost', totalBatchSent === 5, `sent=${totalBatchSent}`);

  delete process.env.SCHEDULER_BATCH_SIZE; // restore the default (200) for every test after this one

  // --- Per-mailbox lanes: campaigns on different mailboxes run concurrently, but a tick's
  // results still have to correctly aggregate every lane back into one combined report. ---
  const secondMailboxResult = await Mailboxes.create({
    domain_id: domainResult.insertId,
    email: 'priya@kabilhirehq.com',
    display_name: 'KabilHire Second Mailbox',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_user: 'priya@kabilhirehq.com',
    smtp_pass_encrypted: encrypted,
    daily_cap: 50
  });
  const secondMailbox = await Mailboxes.get(secondMailboxResult.insertId);

  const laneCampaignA = await Campaigns.create('Lane test - mailbox A', 'pool', user.id);
  await Campaigns.assignMailbox(laneCampaignA.insertId, mailbox.id);
  await Campaigns.addStep(laneCampaignA.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(laneCampaignA.insertId, 'active');
  const laneProspectA = await Prospects.upsert({ email: 'lane.a@example.com', first_name: 'LaneA' });
  await Campaigns.addProspects(laneCampaignA.insertId, [laneProspectA.id]);

  const laneCampaignB = await Campaigns.create('Lane test - mailbox B', 'pool', user.id);
  await Campaigns.assignMailbox(laneCampaignB.insertId, secondMailbox.id);
  await Campaigns.addStep(laneCampaignB.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(laneCampaignB.insertId, 'active');
  const laneProspectB = await Prospects.upsert({ email: 'lane.b@example.com', first_name: 'LaneB' });
  await Campaigns.addProspects(laneCampaignB.insertId, [laneProspectB.id]);

  const laneRun = await scheduler.runOnce({ ignoreWindow: true });
  const laneADetail = laneRun.details.find((d) => d.email === 'lane.a@example.com');
  const laneBDetail = laneRun.details.find((d) => d.email === 'lane.b@example.com');
  check(
    'campaigns on two different mailboxes both send within the same tick, correctly aggregated from separate lanes',
    laneADetail && laneADetail.sent === true && laneBDetail && laneBDetail.sent === true,
    JSON.stringify({ laneADetail, laneBDetail })
  );

  // --- Safety net for true concurrency: the same prospect due in two campaigns on two different
  // mailboxes in the same tick (e.g. one person who's a member of two lists, each targeted by its
  // own campaign - a setup this app explicitly supports) must not bypass the global
  // min-hours-between-emails-to-same-prospect guardrail just because the two campaigns now run in
  // parallel lanes. Only the first (earliest-due) one should actually be processed this tick; the
  // second must be deferred to a later tick, where the real min-gap check then correctly blocks
  // it against the first one's now-recorded send. ---
  const dualListProspect = await Prospects.upsert({ email: 'dual.list.prospect@example.com', first_name: 'Dual' });
  const dualCampaignX = await Campaigns.create('Dual-list test - mailbox A', 'pool', user.id);
  await Campaigns.assignMailbox(dualCampaignX.insertId, mailbox.id);
  await Campaigns.addStep(dualCampaignX.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(dualCampaignX.insertId, 'active');
  await Campaigns.addProspects(dualCampaignX.insertId, [dualListProspect.id]);

  const dualCampaignY = await Campaigns.create('Dual-list test - mailbox B', 'pool', user.id);
  await Campaigns.assignMailbox(dualCampaignY.insertId, secondMailbox.id);
  await Campaigns.addStep(dualCampaignY.insertId, 1, followupResult.insertId, 0, false);
  await Campaigns.setStatus(dualCampaignY.insertId, 'active');
  await Campaigns.addProspects(dualCampaignY.insertId, [dualListProspect.id]);

  const dualFirstRun = await scheduler.runOnce({ ignoreWindow: true });
  const dualFirstRunMatches = dualFirstRun.details.filter((d) => d.email === 'dual.list.prospect@example.com');
  check(
    'the same email due in two campaigns on two different mailboxes is only processed once per tick, not both at once',
    dualFirstRunMatches.length === 1 && dualFirstRunMatches[0].sent === true,
    JSON.stringify(dualFirstRunMatches)
  );

  const dualSecondRun = await scheduler.runOnce({ ignoreWindow: true });
  const dualSecondRunMatch = dualSecondRun.details.find((d) => d.email === 'dual.list.prospect@example.com');
  check(
    'the deferred duplicate is picked up on the next tick and correctly blocked by the real minimum-gap guardrail, not silently sent',
    dualSecondRunMatch && dualSecondRunMatch.sent === false && dualSecondRunMatch.reason === 'min_gap_not_elapsed',
    JSON.stringify(dualSecondRunMatch)
  );

  // dualCampaignY's one prospect is now permanently stuck 'pending' (blocked by the real 72h
  // min-gap guardrail, which nothing in this test run will ever actually satisfy) - left active,
  // it would keep resurfacing as due on every single scheduler.runOnce() call for the rest of this
  // file, including moments later in the suite where the min-gap setting is briefly dropped to 0
  // for an unrelated test, which would let this stale row through and inflate that other test's
  // sent count by one. Pausing the campaign removes it from every future due-list query (listDue
  // requires status='active'), containing this test's side effect the same way other tests in
  // this suite clean up after themselves.
  await Campaigns.setStatus(dualCampaignY.insertId, 'paused');

  // --- Task 2: per-campaign bounce/complaint rate auto-pause (distinct from the pre-existing
  // per-mailbox one) - Campaigns.bounceStatsLast30Days computes a live rolling-30-day rate per
  // campaign from the sends table, and scheduler.autoPauseUnhealthyCampaigns pauses only the
  // specific campaign that crosses the threshold, leaving a healthy sibling on the SAME mailbox
  // untouched - the whole point being that campaigns sharing a mailbox no longer get punished as
  // a group for one campaign's bad list. ---
  const badBounceCampaign = await Campaigns.create('Bounce-rate auto-pause test (bad)', 'pool', user.id);
  await Campaigns.assignMailbox(badBounceCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(badBounceCampaign.insertId, 'active');
  const healthySiblingCampaign = await Campaigns.create('Bounce-rate auto-pause test (healthy sibling)', 'pool', user.id);
  await Campaigns.assignMailbox(healthySiblingCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(healthySiblingCampaign.insertId, 'active');

  const badProspects = [];
  for (let i = 0; i < 20; i++) badProspects.push(await Prospects.upsert({ email: `bad-bounce-${i}@example.com` }));
  await Campaigns.addProspects(badBounceCampaign.insertId, badProspects.map((p) => p.id));
  const badCps = await Campaigns.listCampaignProspects(badBounceCampaign.insertId);
  for (let i = 0; i < badCps.length; i++) await Sends.create(badCps[i].id, mailbox.id, 1, `bad-bounce-token-${i}`);
  // 2 of 20 bounced (10%) - comfortably over the 3% default campaign bounce threshold.
  await Sends.markBounced('bad-bounce-token-0', 'hard');
  await Sends.markBounced('bad-bounce-token-1', 'hard');

  const healthyProspects = [];
  for (let i = 0; i < 20; i++) healthyProspects.push(await Prospects.upsert({ email: `good-bounce-${i}@example.com` }));
  await Campaigns.addProspects(healthySiblingCampaign.insertId, healthyProspects.map((p) => p.id));
  const healthyCps = await Campaigns.listCampaignProspects(healthySiblingCampaign.insertId);
  for (let i = 0; i < healthyCps.length; i++) await Sends.create(healthyCps[i].id, mailbox.id, 1, `good-bounce-token-${i}`);
  // 0 of 20 bounced - stays well under threshold.

  const bounceStats = await Campaigns.bounceStatsLast30Days();
  const badStatsRow = bounceStats.find((r) => Number(r.campaign_id) === badBounceCampaign.insertId);
  check(
    'bounceStatsLast30Days computes the correct total-sent and bounce count for the bad campaign',
    !!badStatsRow && Number(badStatsRow.total_sent) === 20 && Number(badStatsRow.bounce_count) === 2,
    JSON.stringify(badStatsRow)
  );

  // Explicit thresholds here (not await Settings.all()) - this must stay deterministic regardless
  // of whatever auto_pause_campaign_bounce_rate_percent happens to be seeded/configured as (e.g.
  // production's default was deliberately raised to 70 at one point), since this test is about
  // proving the pause mechanism itself works at a known threshold, not about today's live default.
  const bounceTestSettings = { auto_pause_campaign_bounce_rate_percent: 3, auto_pause_campaign_complaint_rate_percent: 0.3 };
  await scheduler.autoPauseUnhealthyCampaigns(bounceTestSettings);
  const badCampaignAfter = await Campaigns.get(badBounceCampaign.insertId);
  const healthyCampaignAfter = await Campaigns.get(healthySiblingCampaign.insertId);
  check('a campaign whose own bounce rate crosses the threshold is auto-paused', badCampaignAfter.status === 'paused', `status=${badCampaignAfter.status}`);
  check('a healthy sibling campaign sharing the same mailbox is left untouched', healthyCampaignAfter.status === 'active', `status=${healthyCampaignAfter.status}`);

  const autoPauseAudit = await AuditLog.list(50);
  const campaignAutoPauseEntry = autoPauseAudit.find((a) => {
    if (a.action !== 'campaign_auto_paused') return false;
    const meta = JSON.parse(a.meta_json);
    return Number(meta.campaign_id) === badBounceCampaign.insertId;
  });
  check(
    'a campaign_auto_paused audit entry was recorded with reason=bounce_rate',
    !!campaignAutoPauseEntry && JSON.parse(campaignAutoPauseEntry.meta_json).reason === 'bounce_rate',
    JSON.stringify(campaignAutoPauseEntry)
  );

  // --- Mid-batch bounce auto-pause: the check above (autoPauseUnhealthyCampaigns) only runs once,
  // at the very start of a scheduler tick - a lane can then spend the rest of that tick sending to
  // every other due prospect in the same campaign, 45-180s apart, with nothing re-checking bounce
  // health until the NEXT tick. Campaigns.bounceStatsForCampaign + scheduler's new
  // checkAndPauseIfCampaignUnhealthy exist to close that gap by re-running the same health math
  // fresh before every individual send (see processOneDueProspect). This proves both: the scoped
  // query returns correct numbers for one campaign in isolation, and a still-'active' campaign
  // whose bounce rate already crossed the line gets paused and its next due prospect skipped
  // rather than sent - not just paused in time for some later tick. ---
  const midBatchCampaign = await Campaigns.create('Mid-batch bounce auto-pause test', 'pool', user.id);
  await Campaigns.assignMailbox(midBatchCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(midBatchCampaign.insertId, 'active');

  const midBatchHistoryProspects = [];
  for (let i = 0; i < 20; i++) midBatchHistoryProspects.push(await Prospects.upsert({ email: `mid-batch-bounce-${i}@example.com` }));
  await Campaigns.addProspects(midBatchCampaign.insertId, midBatchHistoryProspects.map((p) => p.id));
  const midBatchHistoryCps = await Campaigns.listCampaignProspects(midBatchCampaign.insertId);
  for (let i = 0; i < midBatchHistoryCps.length; i++) await Sends.create(midBatchHistoryCps[i].id, mailbox.id, 1, `mid-batch-bounce-token-${i}`);
  // 2 of 20 already bounced (10%) - the campaign is already over threshold, but nothing has
  // re-evaluated it yet, so it's still sitting at status='active' exactly as if a tick were about
  // to send its next due prospect right now.
  await Sends.markBounced('mid-batch-bounce-token-0', 'hard');
  await Sends.markBounced('mid-batch-bounce-token-1', 'hard');

  const scopedStats = await Campaigns.bounceStatsForCampaign(midBatchCampaign.insertId);
  check(
    'bounceStatsForCampaign computes the correct total-sent and bounce count scoped to just this one campaign',
    !!scopedStats && Number(scopedStats.total_sent) === 20 && Number(scopedStats.bounce_count) === 2,
    JSON.stringify(scopedStats)
  );

  const midBatchStillActive = await Campaigns.get(midBatchCampaign.insertId);
  check('the campaign is still active going into its next send, before the mid-batch check runs', midBatchStillActive.status === 'active', `status=${midBatchStillActive.status}`);

  const midBatchExtraProspect = await Prospects.upsert({ email: 'mid-batch-extra@example.com', first_name: 'Extra' });
  await Campaigns.addProspects(midBatchCampaign.insertId, [midBatchExtraProspect.id]);
  const midBatchDueBatch = await CampaignProspects.listDue(require('./lib/dates').toSqlDatetime());
  const midBatchDueCp = midBatchDueBatch.find((d) => d.email === 'mid-batch-extra@example.com');
  check('the campaign\'s next due prospect was captured while still active', !!midBatchDueCp, JSON.stringify(midBatchDueCp));

  const midBatchResult = await scheduler.processOneDueProspect(midBatchDueCp, {
    baseUrl: 'http://localhost:4000', companyName: 'Techforce Global', companyAddress: '', settings: bounceTestSettings
  });
  check(
    'the next due prospect is skipped (not sent) because its campaign crossed the bounce threshold mid-batch',
    midBatchResult.sent === false && midBatchResult.reason === 'campaign_auto_paused_mid_batch',
    JSON.stringify(midBatchResult)
  );

  const midBatchCampaignAfter = await Campaigns.get(midBatchCampaign.insertId);
  check('the campaign is paused immediately, mid-batch, not left active until the next tick', midBatchCampaignAfter.status === 'paused', `status=${midBatchCampaignAfter.status}`);

  const midBatchSends = await require('./db/index').query('SELECT * FROM sends WHERE campaign_prospect_id = ?', [midBatchDueCp.id]);
  check('no send row was created for the prospect that triggered the mid-batch pause', midBatchSends.length === 0, `sends=${midBatchSends.length}`);

  const midBatchSkipActivity = (await ActivityLog.list({ limit: 50 })).find((a) => a.event_type === 'skipped' && a.prospect_email === 'mid-batch-extra@example.com');
  check(
    'a "skipped" activity row with reason campaign_auto_paused_mid_batch was logged',
    midBatchSkipActivity && midBatchSkipActivity.reason === 'campaign_auto_paused_mid_batch',
    JSON.stringify(midBatchSkipActivity)
  );

  const midBatchAudit = (await AuditLog.list(50)).find((a) => {
    if (a.action !== 'campaign_auto_paused') return false;
    const meta = JSON.parse(a.meta_json);
    return Number(meta.campaign_id) === midBatchCampaign.insertId && meta.mid_batch === true;
  });
  check('a campaign_auto_paused audit entry with mid_batch=true was recorded', !!midBatchAudit, JSON.stringify(midBatchAudit));

  // A healthy campaign (no bounces at all) must NOT be touched by the same mid-batch check.
  const midBatchHealthyCampaign = await Campaigns.create('Mid-batch bounce auto-pause test (healthy)', 'pool', user.id);
  await Campaigns.assignMailbox(midBatchHealthyCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(midBatchHealthyCampaign.insertId, 'active');
  const midBatchHealthyProspects = [];
  for (let i = 0; i < 20; i++) midBatchHealthyProspects.push(await Prospects.upsert({ email: `mid-batch-healthy-${i}@example.com` }));
  await Campaigns.addProspects(midBatchHealthyCampaign.insertId, midBatchHealthyProspects.map((p) => p.id));
  const midBatchHealthyCps = await Campaigns.listCampaignProspects(midBatchHealthyCampaign.insertId);
  for (let i = 0; i < midBatchHealthyCps.length; i++) await Sends.create(midBatchHealthyCps[i].id, mailbox.id, 1, `mid-batch-healthy-token-${i}`);
  const midBatchHealthyPaused = await scheduler.checkAndPauseIfCampaignUnhealthy(midBatchHealthyCampaign.insertId, bounceTestSettings);
  const midBatchHealthyCampaignAfter = await Campaigns.get(midBatchHealthyCampaign.insertId);
  check(
    'checkAndPauseIfCampaignUnhealthy leaves a healthy campaign active and returns false',
    midBatchHealthyPaused === false && midBatchHealthyCampaignAfter.status === 'active',
    `paused=${midBatchHealthyPaused} status=${midBatchHealthyCampaignAfter.status}`
  );

  // The mid-batch check used to require >=20 total sends before evaluating at all (a minimum
  // sample size, to stop 1 bounce out of 1-2 sends looking like a scary 50-100% rate). That floor
  // was deliberately removed by request - a campaign should now pause the instant its bounce rate
  // crosses the threshold, even on send #1, rather than being allowed to keep sending until a
  // bigger sample builds up. This proves the zero-minimum behavior directly: 1 send, 1 bounce =
  // 100%, which is over even a generous threshold, so it must pause immediately.
  const instantPauseCampaign = await Campaigns.create('Instant bounce auto-pause test (no minimum)', 'pool', user.id);
  await Campaigns.assignMailbox(instantPauseCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(instantPauseCampaign.insertId, 'active');
  const instantPauseProspect = await Prospects.upsert({ email: 'instant-pause-bounce@example.com' });
  await Campaigns.addProspects(instantPauseCampaign.insertId, [instantPauseProspect.id]);
  const instantPauseCps = await Campaigns.listCampaignProspects(instantPauseCampaign.insertId);
  await Sends.create(instantPauseCps[0].id, mailbox.id, 1, 'instant-pause-bounce-token');
  await Sends.markBounced('instant-pause-bounce-token', 'hard');

  const instantPauseStats = await Campaigns.bounceStatsForCampaign(instantPauseCampaign.insertId);
  check(
    'a single send that bounced is scoped correctly: total_sent=1, bounce_count=1',
    !!instantPauseStats && Number(instantPauseStats.total_sent) === 1 && Number(instantPauseStats.bounce_count) === 1,
    JSON.stringify(instantPauseStats)
  );

  const instantPaused = await scheduler.checkAndPauseIfCampaignUnhealthy(instantPauseCampaign.insertId, bounceTestSettings);
  const instantPauseCampaignAfter = await Campaigns.get(instantPauseCampaign.insertId);
  check(
    'a campaign with just 1 send that bounced (100%) is paused immediately - no minimum sample size required',
    instantPaused === true && instantPauseCampaignAfter.status === 'paused',
    `paused=${instantPaused} status=${instantPauseCampaignAfter.status}`
  );

  // Removing the minimum-sample floor above (previous check) had a real downside reported from
  // production: on a small list, 1 unlucky bounce right at the start looks like a 100% disaster
  // even if the list is actually fine. The fix: judge the rate against the campaign's TOTAL
  // recipient count, not just however many have been sent to so far - see evaluateCampaignBounceHealth's
  // comment in lib/scheduler.js. These two tests prove both halves of that fix directly.
  const recipientScaledSettings = { auto_pause_campaign_bounce_rate_percent: 30, auto_pause_campaign_complaint_rate_percent: 100 };

  // Half 1: a single early bounce on a good-sized list must NOT pause the campaign - the other 28
  // people haven't been tested yet, so 1 bounce out of 29 total recipients (3.4%) is nowhere near
  // a 30% threshold, even though it's 100% of sends-so-far.
  const scaledSafeCampaign = await Campaigns.create('Recipient-scaled bounce test (safe)', 'pool', user.id);
  await Campaigns.assignMailbox(scaledSafeCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(scaledSafeCampaign.insertId, 'active');
  const scaledSafeProspects = [];
  for (let i = 0; i < 29; i++) scaledSafeProspects.push(await Prospects.upsert({ email: `scaled-safe-${i}@example.com` }));
  await Campaigns.addProspects(scaledSafeCampaign.insertId, scaledSafeProspects.map((p) => p.id));
  const scaledSafeCps = await Campaigns.listCampaignProspects(scaledSafeCampaign.insertId);
  await Sends.create(scaledSafeCps[0].id, mailbox.id, 1, 'scaled-safe-token-0');
  await Sends.markBounced('scaled-safe-token-0', 'hard');

  const scaledSafeStats = await Campaigns.bounceStatsForCampaign(scaledSafeCampaign.insertId);
  check(
    'total_recipients reflects everyone added to the campaign (29), not just the 1 who has been sent to',
    !!scaledSafeStats && Number(scaledSafeStats.total_recipients) === 29 && Number(scaledSafeStats.bounce_count) === 1,
    JSON.stringify(scaledSafeStats)
  );

  const scaledSafePaused = await scheduler.checkAndPauseIfCampaignUnhealthy(scaledSafeCampaign.insertId, recipientScaledSettings);
  const scaledSafeCampaignAfter = await Campaigns.get(scaledSafeCampaign.insertId);
  check(
    '1 bounce out of 1 send on a 29-recipient campaign (3.4%) does NOT pause at a 30% threshold - the fix for the exact scenario reported from production',
    scaledSafePaused === false && scaledSafeCampaignAfter.status === 'active',
    `paused=${scaledSafePaused} status=${scaledSafeCampaignAfter.status} rate=${(1 / 29 * 100).toFixed(1)}%`
  );

  // Half 2: a small explicit list still pauses exactly when the real numbers say it should - 3
  // bounces out of 10 total recipients at a 30% threshold is precisely 30%. Reaching the threshold
  // counts as crossing it (>=, not strictly >), matching this exact worked example from the user.
  const scaledTripCampaign = await Campaigns.create('Recipient-scaled bounce test (trips)', 'pool', user.id);
  await Campaigns.assignMailbox(scaledTripCampaign.insertId, mailbox.id);
  await Campaigns.setStatus(scaledTripCampaign.insertId, 'active');
  const scaledTripProspects = [];
  for (let i = 0; i < 10; i++) scaledTripProspects.push(await Prospects.upsert({ email: `scaled-trip-${i}@example.com` }));
  await Campaigns.addProspects(scaledTripCampaign.insertId, scaledTripProspects.map((p) => p.id));
  const scaledTripCps = await Campaigns.listCampaignProspects(scaledTripCampaign.insertId);
  for (let i = 0; i < 3; i++) {
    await Sends.create(scaledTripCps[i].id, mailbox.id, 1, `scaled-trip-token-${i}`);
    await Sends.markBounced(`scaled-trip-token-${i}`, 'hard');
  }

  const scaledTripStats = await Campaigns.bounceStatsForCampaign(scaledTripCampaign.insertId);
  check(
    'total_recipients is 10 (the full list) while only 3 have actually been sent to and bounced',
    !!scaledTripStats && Number(scaledTripStats.total_recipients) === 10 && Number(scaledTripStats.total_sent) === 3 && Number(scaledTripStats.bounce_count) === 3,
    JSON.stringify(scaledTripStats)
  );

  const scaledTripPaused = await scheduler.checkAndPauseIfCampaignUnhealthy(scaledTripCampaign.insertId, recipientScaledSettings);
  const scaledTripCampaignAfter = await Campaigns.get(scaledTripCampaign.insertId);
  check(
    '3 bounces out of 10 total recipients (exactly 30%) pauses at a 30% threshold - reaching the line counts as crossing it',
    scaledTripPaused === true && scaledTripCampaignAfter.status === 'paused',
    `paused=${scaledTripPaused} status=${scaledTripCampaignAfter.status}`
  );

  // --- Plain-SMTP bounce capture (Task 2b): parsing real bounce-back emails (DSNs) found via
  // IMAP polling - see lib/bounceCapture.js. These are pure parsing functions with no network
  // dependency, so unlike the IMAP connection itself (untestable without a real mail server) they
  // get full, real coverage here: a structured RFC 3464 hard bounce, a structured soft/delayed
  // bounce, an unstructured legacy bounce with no machine-readable block at all, and a normal
  // human reply that must NOT be mistaken for a bounce. ---
  const { parseDsn, looksLikeBounce } = require('./lib/bounceCapture');
  const { simpleParser } = require('mailparser');

  const hardBounceRaw = 'From: Mailer Daemon <mailer-daemon@example.com>\r\nTo: sender@example.com\r\nSubject: Undelivered Mail Returned to Sender\r\nContent-Type: text/plain\r\n\r\nThis is a bounce.\r\n\r\nFinal-Recipient: rfc822; dsn-hard-bounce@example.com\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 No such user\r\n';
  const hardEnvelope = await simpleParser(hardBounceRaw);
  check('a structured hard-bounce DSN is recognized as a bounce by sender/subject', looksLikeBounce(hardEnvelope));
  const hardRecipients = await parseDsn(hardBounceRaw);
  check(
    'a structured hard-bounce DSN with Status 5.x is parsed as type=hard for the right recipient',
    hardRecipients.length === 1 && hardRecipients[0].email === 'dsn-hard-bounce@example.com' && hardRecipients[0].type === 'hard',
    JSON.stringify(hardRecipients)
  );

  const softBounceRaw = 'From: MAILER-DAEMON@example.com\r\nTo: sender@example.com\r\nSubject: Delivery Status Notification (Delay)\r\nContent-Type: text/plain\r\n\r\nDelayed.\r\n\r\nFinal-Recipient: rfc822; dsn-soft-bounce@example.com\r\nAction: delayed\r\nStatus: 4.4.7\r\n';
  const softRecipients = await parseDsn(softBounceRaw);
  check(
    'a structured delay/soft-bounce DSN with Status 4.x is parsed as type=soft',
    softRecipients.length === 1 && softRecipients[0].email === 'dsn-soft-bounce@example.com' && softRecipients[0].type === 'soft',
    JSON.stringify(softRecipients)
  );

  const legacyBounceRaw = 'From: postmaster@oldmailserver.com\r\nTo: sender@example.com\r\nSubject: Mail delivery failed: returning message to sender\r\nContent-Type: text/plain\r\n\r\nThis message was created automatically.\r\n\r\nDelivery to the following recipient failed permanently:\r\n\r\n     legacy-bounce@oldmailserver.com\r\n';
  const legacyEnvelope = await simpleParser(legacyBounceRaw);
  check('an unstructured legacy bounce (no Final-Recipient block) is still recognized via sender+subject', looksLikeBounce(legacyEnvelope));
  const legacyRecipients = await parseDsn(legacyBounceRaw);
  check(
    'an unstructured legacy bounce falls back to the plain-text pattern and still finds the right recipient',
    legacyRecipients.length === 1 && legacyRecipients[0].email === 'legacy-bounce@oldmailserver.com',
    JSON.stringify(legacyRecipients)
  );

  const normalReplyRaw = 'From: John Doe <john@example.com>\r\nTo: sender@example.com\r\nSubject: Re: Hello\r\nContent-Type: text/plain\r\n\r\nThanks for reaching out!\r\n';
  const normalReplyEnvelope = await simpleParser(normalReplyRaw);
  check('a normal human reply is never mistaken for a bounce', looksLikeBounce(normalReplyEnvelope) === false);

  // --- Mailboxes.updateBounceCaptureSettings: the repo-level persistence the new
  // PATCH /api/mailboxes/:id/bounce-capture route relies on (see http-smoke-test.js for the full
  // HTTP-level coverage of that route's validation rules). ---
  const bounceCaptureTestMailbox = await Mailboxes.create({
    domain_id: domainResult.insertId,
    email: 'bounce-capture-repo-test@kabilhirehq.com',
    display_name: 'Bounce Capture Repo Test',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_user: 'bounce-capture-repo-test@kabilhirehq.com',
    smtp_pass_encrypted: encrypted,
    daily_cap: 30
  });
  const beforeCapture = await Mailboxes.get(bounceCaptureTestMailbox.insertId);
  check('a new mailbox defaults to bounce_capture_method=none', beforeCapture.bounce_capture_method === 'none', beforeCapture.bounce_capture_method);

  await Mailboxes.updateBounceCaptureSettings(bounceCaptureTestMailbox.insertId, {
    bounce_capture_method: 'imap',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_user: 'bounce-capture-repo-test@kabilhirehq.com',
    imap_pass_encrypted: encrypted
  });
  const afterCapture = await Mailboxes.get(bounceCaptureTestMailbox.insertId);
  check(
    'updateBounceCaptureSettings persists the IMAP capture method and connection details',
    afterCapture.bounce_capture_method === 'imap' && afterCapture.imap_host === 'imap.gmail.com' && afterCapture.imap_user === 'bounce-capture-repo-test@kabilhirehq.com',
    JSON.stringify({ method: afterCapture.bounce_capture_method, host: afterCapture.imap_host, user: afterCapture.imap_user })
  );

  // --- Open/click tracking + unsubscribe flow, exactly as the public /track routes would do ---
  const theSend = sendsRows[0];
  await Sends.markOpened(theSend.tracking_token);
  await Sends.markClicked(theSend.tracking_token);
  const afterEngagement = await Sends.findByToken(theSend.tracking_token);
  check('open recorded', !!afterEngagement.opened_at);
  check('click recorded', !!afterEngagement.clicked_at);

  // --- ActivityLog.recordEngagement is what routes/track.js calls for opens/clicks/bounces
  // (it only ever has a tracking token to start from) - exercised directly here since this
  // suite runs against the repo layer, not real HTTP requests (see http-smoke-test.js for that). ---
  await ActivityLog.recordEngagement(theSend, 'opened');
  await ActivityLog.recordEngagement(theSend, 'clicked');
  const engagementActivity = await ActivityLog.list({ limit: 50 });
  const openedActivity = engagementActivity.find((a) => a.event_type === 'opened' && a.prospect_email === 'founder.a@example.com');
  const clickedActivity = engagementActivity.find((a) => a.event_type === 'clicked' && a.prospect_email === 'founder.a@example.com');
  check('recordEngagement logs an "opened" row resolved from just a send record', !!openedActivity, JSON.stringify(openedActivity));
  check('recordEngagement logs a "clicked" row resolved from just a send record', !!clickedActivity, JSON.stringify(clickedActivity));
  check('the resolved "opened" row carries the campaign name (looked up via campaign_prospect_id)', openedActivity && openedActivity.campaign_name === 'Kabilhire - SaaS founders', JSON.stringify(openedActivity));

  const missingSendEngagement = await ActivityLog.recordEngagement(null, 'opened');
  check('recordEngagement no-ops gracefully when given no send (invalid/expired token)', missingSendEngagement === undefined);

  const cpBefore = await CampaignProspects.get(theSend.campaign_prospect_id);
  const engaged = await Sends.hasEngagement(cpBefore.id, 1);
  check('engagement lookup for step 1 returns true after open+click', engaged === true);

  // --- listCampaignProspects: Opened/Clicked/Unsubscribed columns for the campaign-detail
  // prospect table redesign. founder.a opened+clicked step 1 above; founder.b never engaged
  // and is only suppressed for reason 'manual' (not a real unsubscribe), which should NOT tick
  // the Unsubscribed column - that's the precise distinction the feature is built on. ---
  const engagementCpRows = await Campaigns.listCampaignProspects(campaignResult.insertId);
  const founderARow = engagementCpRows.find((r) => r.email === 'founder.a@example.com');
  const founderBRow = engagementCpRows.find((r) => r.email === 'founder.b@example.com');
  check('listCampaignProspects reports opened=true for a prospect who opened', !!founderARow?.opened, JSON.stringify(founderARow));
  check('listCampaignProspects reports which step was opened', Number(founderARow?.opened_step) === 1, `opened_step=${founderARow?.opened_step}`);
  check('listCampaignProspects reports clicked=true for a prospect who clicked', !!founderARow?.clicked, JSON.stringify(founderARow));
  check('listCampaignProspects reports which step was clicked', Number(founderARow?.clicked_step) === 1, `clicked_step=${founderARow?.clicked_step}`);
  check('listCampaignProspects reports opened=false for a prospect with no opens', !founderBRow?.opened, JSON.stringify(founderBRow));
  check('listCampaignProspects reports clicked=false for a prospect with no clicks', !founderBRow?.clicked, JSON.stringify(founderBRow));
  check('a "manual" suppression reason does NOT count as Unsubscribed', !founderBRow?.unsubscribed, JSON.stringify(founderBRow));

  // --- Positive case: a genuine unsubscribe-link click (reason 'unsubscribed') must tick the
  // Unsubscribed column - uses a throwaway prospect/campaign so it doesn't disturb founder.a/b,
  // who are reused by later tests further down this suite. ---
  const unsubProspect = await Prospects.upsert({ email: 'unsub.test@example.com', first_name: 'Unsub' });
  const unsubCampaign = await Campaigns.create('Unsub column test', 'pool', user.id);
  await Campaigns.addProspects(unsubCampaign.insertId, [unsubProspect.id]);
  await Suppression.add('unsub.test@example.com', 'unsubscribed');
  const unsubCpRows = await Campaigns.listCampaignProspects(unsubCampaign.insertId);
  const unsubRow = unsubCpRows.find((r) => r.email === 'unsub.test@example.com');
  check('a real unsubscribe (reason "unsubscribed") does tick the Unsubscribed column', !!unsubRow?.unsubscribed, JSON.stringify(unsubRow));

  check('suppression list contains the manually-suppressed email', await Suppression.isSuppressed('founder.b@example.com'));
  check('suppression list does NOT contain an untouched email', (await Suppression.isSuppressed('founder.a@example.com')) === false);

  // --- Suppression.remove: un-suppressing must delete the suppression_list row AND clear the
  // prospect's denormalized is_suppressed flag. Previously nothing ever cleared that flag, so a
  // prospect's Status kept showing "Suppressed" even after their suppression_list row was gone -
  // this is exactly the bug reported live and being fixed here. ---
  const suppressionRowsBeforeRemove = await Suppression.list();
  const founderBSuppressionRow = suppressionRowsBeforeRemove.find((r) => r.email === 'founder.b@example.com');
  check('the manually-suppressed email has a suppression_list row to remove', !!founderBSuppressionRow);
  const prospectBBeforeRemove = await Prospects.get(prospectB.id);
  check('prospect B is flagged is_suppressed before removal', prospectBBeforeRemove.is_suppressed === 1, `is_suppressed=${prospectBBeforeRemove.is_suppressed}`);
  const removedEmail = await Suppression.remove(founderBSuppressionRow.id);
  check('Suppression.remove returns the removed email', removedEmail === 'founder.b@example.com', `removedEmail=${removedEmail}`);
  check('suppression list no longer contains the removed email', (await Suppression.isSuppressed('founder.b@example.com')) === false);
  const prospectBAfterRemove = await Prospects.get(prospectB.id);
  check('prospect B\'s is_suppressed flag is cleared after removal', prospectBAfterRemove.is_suppressed === 0, `is_suppressed=${prospectBAfterRemove.is_suppressed}`);
  const removeUnknownId = await Suppression.remove(999999);
  check('Suppression.remove returns null for an unknown id', removeUnknownId === null);

  // Re-suppress founder.b so the rest of this suite (which assumes they're still suppressed
  // below) continues to hold.
  await Suppression.add('founder.b@example.com', 'manual');
  check('re-adding after removal restores suppression', await Suppression.isSuppressed('founder.b@example.com'));
  const prospectBReSuppressed = await Prospects.get(prospectB.id);
  check('re-adding after removal restores the prospect\'s is_suppressed flag', prospectBReSuppressed.is_suppressed === 1, `is_suppressed=${prospectBReSuppressed.is_suppressed}`);

  // --- Adding an already-suppressed prospect to a brand-new campaign must not create a
  // sendable 'pending' row - it should land as 'unsubscribed' immediately, and the caller
  // should be told how many were skipped this way. ---
  const suppressionAddResult = await Campaigns.addProspects(campaignResult.insertId, [prospectB.id]);
  check('re-adding an already-suppressed prospect reports 0 added', suppressionAddResult.added === 0, `added=${suppressionAddResult.added}`);
  const freshCampaignForSuppression = await Campaigns.create('Fresh campaign for suppression check', 'pool', user.id);
  const freshAddResult = await Campaigns.addProspects(freshCampaignForSuppression.insertId, [prospectA.id, prospectB.id]);
  check('adding one clean + one suppressed prospect reports added=1', freshAddResult.added === 1, `added=${freshAddResult.added}`);
  check('adding one clean + one suppressed prospect reports skippedSuppressed=1', freshAddResult.skippedSuppressed === 1, `skippedSuppressed=${freshAddResult.skippedSuppressed}`);
  const suppressedRow = freshAddResult.rows.find((r) => r.prospect_id === prospectB.id);
  check('the suppressed prospect\'s new campaign_prospects row is stopped, not pending', suppressedRow && suppressedRow.status === 'unsubscribed');
  const suppressedRowFull = await CampaignProspects.get(suppressedRow.id);
  check('the suppressed row has no next_due_at, so the scheduler will never pick it up', suppressedRowFull.next_due_at === null);
  const dueAfterSuppressedAdd = await CampaignProspects.listDue(require('./lib/dates').toSqlDatetime(new Date(Date.now() + 3600000)));
  check(
    'listDue never surfaces the suppressed row even looking an hour into the future',
    !dueAfterSuppressedAdd.some((r) => r.id === suppressedRow.id)
  );

  // --- wait_hours: a sequence step's wait can include a partial day (e.g. "2 hours later")
  // instead of only whole-day gaps ---
  check(
    'stepWaitMs adds wait_days and wait_hours together',
    scheduler.stepWaitMs({ wait_days: 2, wait_hours: 6 }) === 2 * 86400000 + 6 * 3600000
  );
  check('stepWaitMs treats a missing wait_hours as 0', scheduler.stepWaitMs({ wait_days: 1 }) === 86400000);
  check('stepWaitMs handles a 0-day, hours-only wait', scheduler.stepWaitMs({ wait_days: 0, wait_hours: 3 }) === 3 * 3600000);

  // --- wait_minutes: same idea as wait_hours, one level finer - a step can wait a partial hour
  // (e.g. "30 minutes later") instead of only whole-hour/whole-day gaps ---
  check(
    'stepWaitMs adds wait_days, wait_hours and wait_minutes together',
    scheduler.stepWaitMs({ wait_days: 2, wait_hours: 6, wait_minutes: 30 }) === 2 * 86400000 + 6 * 3600000 + 30 * 60000
  );
  check('stepWaitMs treats a missing wait_minutes as 0', scheduler.stepWaitMs({ wait_days: 1, wait_hours: 2 }) === 86400000 + 2 * 3600000);
  check('stepWaitMs handles a minutes-only wait', scheduler.stepWaitMs({ wait_days: 0, wait_hours: 0, wait_minutes: 45 }) === 45 * 60000);

  // --- projectCampaignCompletion: the "how long will this whole campaign take" projection
  // behind the Schedule/Send-now confirm popup's completion estimate. Pure function, plain
  // objects in/out - no DB needed to exercise the actual day-by-day capacity math. ---
  {
    const fullyRampedMailbox = { status: 'active', daily_cap: 10, warmup_start_cap: 10, warmup_ramp_days: 0, warmup_start_date: '2000-01-01' };
    const flatStart = new Date('2026-01-01T00:00:00Z'); // a Thursday, but weekdays-only is off below anyway

    const singleMailboxResult = scheduler.projectCampaignCompletion({
      startDate: flatStart,
      mailboxes: [fullyRampedMailbox],
      prospectsCount: 25,
      stepCount: 1,
      settings: { send_only_weekdays: 'false' }
    });
    check(
      'a single 10/day mailbox reaches 25 prospects (step 1) on day 3 (10+10+10=30 >= 25)',
      singleMailboxResult.step1_complete_at === '2026-01-03',
      JSON.stringify(singleMailboxResult)
    );
    check(
      'with only 1 step, full-sequence-complete matches step-1-complete exactly',
      singleMailboxResult.full_sequence_complete_at === singleMailboxResult.step1_complete_at
    );
    check('combined_daily_capacity_today reflects the single mailbox\'s cap', singleMailboxResult.combined_daily_capacity_today === 10);

    const twoMailboxes = [
      { status: 'active', daily_cap: 5, warmup_start_cap: 5, warmup_ramp_days: 0, warmup_start_date: '2000-01-01' },
      { status: 'active', daily_cap: 5, warmup_start_cap: 5, warmup_ramp_days: 0, warmup_start_date: '2000-01-01' }
    ];
    const twoStepResult = scheduler.projectCampaignCompletion({
      startDate: flatStart,
      mailboxes: twoMailboxes,
      prospectsCount: 20,
      stepCount: 2,
      settings: { send_only_weekdays: 'false' }
    });
    check(
      'two 5/day mailboxes (10/day combined) reach 20 prospects (step 1 target) on day 2',
      twoStepResult.step1_complete_at === '2026-01-02',
      JSON.stringify(twoStepResult)
    );
    check(
      'the same pool reaches the full 2-step target (40 sends) on day 4, later than step-1-complete',
      twoStepResult.full_sequence_complete_at === '2026-01-04' && twoStepResult.full_sequence_complete_at !== twoStepResult.step1_complete_at,
      JSON.stringify(twoStepResult)
    );

    // --- alreadyCompletedSteps: lets the exact same projection double as "how much longer from
    // here" for a campaign that's already mid-flight, by shrinking the full-sequence target by
    // whatever's already been sent (current_step_sum) instead of always counting from zero. ---
    const halfDoneResult = scheduler.projectCampaignCompletion({
      startDate: flatStart,
      mailboxes: twoMailboxes,
      prospectsCount: 20,
      stepCount: 2,
      settings: { send_only_weekdays: 'false' },
      alreadyCompletedSteps: 20 // step 1 already sent to everyone - only the 20 step-2 sends remain
    });
    check(
      'with 20 of 40 total steps already sent, the full-sequence target shrinks to the remaining 20, completing on day 2 (10/day combined)',
      halfDoneResult.full_sequence_complete_at === '2026-01-02',
      JSON.stringify(halfDoneResult)
    );
    check(
      'omitting alreadyCompletedSteps entirely defaults to 0 - identical to the original fresh-campaign math',
      scheduler.projectCampaignCompletion({ startDate: flatStart, mailboxes: twoMailboxes, prospectsCount: 20, stepCount: 2, settings: { send_only_weekdays: 'false' } }).full_sequence_complete_at === twoStepResult.full_sequence_complete_at
    );
    const fullyDoneResult = scheduler.projectCampaignCompletion({
      startDate: flatStart,
      mailboxes: twoMailboxes,
      prospectsCount: 20,
      stepCount: 2,
      settings: { send_only_weekdays: 'false' },
      alreadyCompletedSteps: 40 // every step already sent to everyone - nothing left to project
    });
    const flatStartDayStr = flatStart.toISOString().slice(0, 10);
    check(
      'when alreadyCompletedSteps already meets or exceeds the full target, both dates report as already done (today), not null or a future date',
      fullyDoneResult.full_sequence_complete_at === flatStartDayStr && fullyDoneResult.step1_complete_at === flatStartDayStr,
      JSON.stringify(fullyDoneResult)
    );

    const pausedMailbox ={ status: 'paused', daily_cap: 30, warmup_start_cap: 30, warmup_ramp_days: 0, warmup_start_date: '2000-01-01' };
    const noCapacityResult = scheduler.projectCampaignCompletion({
      startDate: flatStart, mailboxes: [pausedMailbox], prospectsCount: 10, stepCount: 1, settings: { send_only_weekdays: 'false' }
    });
    check(
      'an entirely paused mailbox pool returns null completion dates instead of looping forever',
      noCapacityResult.step1_complete_at === null && noCapacityResult.full_sequence_complete_at === null,
      JSON.stringify(noCapacityResult)
    );
    check('a paused mailbox reports 0 combined capacity today', noCapacityResult.combined_daily_capacity_today === 0);

    // Weekend-skip: rather than hardcode a real calendar date's weekday, find the next actual
    // Saturday from right now and start the simulation there - a huge daily cap means the very
    // first counted day satisfies the target, so the completion date IS the first non-weekend
    // day on or after the start, proving Sat/Sun really get skipped rather than just being slow.
    const now = new Date();
    const daysUntilSaturday = (6 - now.getUTCDay() + 7) % 7;
    const saturdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSaturday));
    const hugeCapMailbox = { status: 'active', daily_cap: 100000, warmup_start_cap: 100000, warmup_ramp_days: 0, warmup_start_date: '2000-01-01' };
    // settings.send_only_weekdays is passed explicitly as 'true' here (not left to fall back to
    // process.env) because this suite sets SEND_ONLY_WEEKDAYS=false globally near the top of
    // this file, so every other scheduler test can run any day of the week - this is the one
    // test that specifically wants weekday-only behavior regardless of that override.
    const weekendResult = scheduler.projectCampaignCompletion({
      startDate: saturdayStart, mailboxes: [hugeCapMailbox], prospectsCount: 10, stepCount: 1, settings: { send_only_weekdays: 'true' }
    });
    const completeWeekday = new Date(`${weekendResult.step1_complete_at}T00:00:00Z`).getUTCDay();
    check(
      'starting the simulation on a Saturday with weekdays-only default skips the weekend, landing on a weekday',
      completeWeekday !== 0 && completeWeekday !== 6,
      weekendResult.step1_complete_at
    );

    // Ties the reported "today" capacity number back to the real warmup ramp formula
    // (warmup.js's capOnDate), so a future refactor of either can't silently drift apart.
    const { capOnDate } = require('./lib/warmup');
    const rampingMailbox = { status: 'active', daily_cap: 25, warmup_start_cap: 5, warmup_ramp_days: 20, warmup_start_date: new Date().toISOString().slice(0, 10) };
    const rampResult = scheduler.projectCampaignCompletion({
      startDate: new Date(), mailboxes: [rampingMailbox], prospectsCount: 5, stepCount: 1, settings: { send_only_weekdays: 'false' }
    });
    check(
      'combined_daily_capacity_today matches the mailbox\'s actual warmup-ramp cap for today, not the flat daily_cap',
      rampResult.combined_daily_capacity_today === capOnDate(rampingMailbox, new Date())
    );
  }

  const hoursCampaign = await Campaigns.create('Hours-wait campaign', 'pool', user.id);
  await Campaigns.assignMailbox(hoursCampaign.insertId, mailbox.id);
  await Campaigns.addStep(hoursCampaign.insertId, 1, templateResult.insertId, 0, false, 0); // due immediately
  await Campaigns.addStep(hoursCampaign.insertId, 2, followupResult.insertId, 0, false, 2); // due 2 hours after step 1, not a full day
  await Campaigns.setStatus(hoursCampaign.insertId, 'active');
  const prospectHours = await Prospects.upsert({ email: 'hours-wait@example.com', first_name: 'Hours' });
  await Campaigns.addProspects(hoursCampaign.insertId, [prospectHours.id]);
  const hoursRun = await scheduler.runOnce({ ignoreWindow: true });
  check('the hours-wait campaign prospect was sent step 1', hoursRun.details.some((d) => d.email === 'hours-wait@example.com' && d.sent));

  const cpHoursRows = await dbIndex.query(
    'SELECT * FROM campaign_prospects WHERE campaign_id = ? AND prospect_id = ?',
    [hoursCampaign.insertId, prospectHours.id]
  );
  const nextDueMs = new Date(cpHoursRows[0].next_due_at.replace(' ', 'T') + 'Z').getTime();
  const expectedMs = Date.now() + 2 * 3600000;
  check(
    'a 0-day/2-hour wait step becomes due about 2 hours out, not 1 day',
    Math.abs(nextDueMs - expectedMs) < 60000,
    `diff_ms=${nextDueMs - expectedMs}`
  );

  // --- Engagement branching: a step_order can have up to 3 sequence_steps rows (clicked/
  // opened/default), and the scheduler must pick whichever one matches how the prospect
  // engaged with the PREVIOUS step. Driven through the real send -> mark -> runOnce flow
  // (not by calling the internal picker directly), matching how the rest of this suite
  // favors integration checks over reaching into scheduler internals. ---
  const branchClickedTemplate = await Templates.create({
    name: 'Branch - clicked', type: 'text', folder: 'Branching test',
    sender_name: 'Tester', subject: 'You clicked', preview_text: '', body_html: '', body_text: 'Thanks for clicking.', status: 'active'
  });
  const branchOpenedTemplate = await Templates.create({
    name: 'Branch - opened', type: 'text', folder: 'Branching test',
    sender_name: 'Tester', subject: 'You opened', preview_text: '', body_html: '', body_text: 'Thanks for opening.', status: 'active'
  });
  const branchDefaultTemplate = await Templates.create({
    name: 'Branch - default', type: 'text', folder: 'Branching test',
    sender_name: 'Tester', subject: 'Just checking in', preview_text: '', body_html: '', body_text: 'Just checking in.', status: 'active'
  });

  const branchCampaign = await Campaigns.create('Branching test campaign', 'pool', user.id);
  await Campaigns.assignMailbox(branchCampaign.insertId, mailbox.id);
  await Campaigns.addStep(branchCampaign.insertId, 1, templateResult.insertId, 0, false); // step 1 never branches
  await Campaigns.setStepBranches(branchCampaign.insertId, 2, {
    waitDays: 0, waitHours: 0, skipIfEngaged: false,
    branches: [
      { condition: 'clicked', template_id: branchClickedTemplate.insertId },
      { condition: 'opened', template_id: branchOpenedTemplate.insertId },
      { condition: null, template_id: branchDefaultTemplate.insertId }
    ]
  });
  await Campaigns.setStatus(branchCampaign.insertId, 'active');

  const branchSteps = await Campaigns.listSteps(branchCampaign.insertId);
  check(
    'setStepBranches creates 3 sequence_steps rows sharing step_order 2',
    branchSteps.filter((s) => s.step_order === 2).length === 3,
    `${branchSteps.filter((s) => s.step_order === 2).length}`
  );
  check('step 1 remains a single row (branching only ever starts from step 2)', branchSteps.filter((s) => s.step_order === 1).length === 1);

  const pBranchClicked = await Prospects.upsert({ email: 'branch-clicked@example.com', first_name: 'Clicked' });
  const pBranchOpened = await Prospects.upsert({ email: 'branch-opened@example.com', first_name: 'Opened' });
  const pBranchDefault = await Prospects.upsert({ email: 'branch-default@example.com', first_name: 'Default' });
  const pBranchBoth = await Prospects.upsert({ email: 'branch-both@example.com', first_name: 'Both' });
  await Campaigns.addProspects(branchCampaign.insertId, [pBranchClicked.id, pBranchOpened.id, pBranchDefault.id, pBranchBoth.id]);

  const branchFirstRun = await scheduler.runOnce({ ignoreWindow: true });
  check('branching campaign step 1 sent to all 4 prospects', branchFirstRun.sent === 4, `sent=${branchFirstRun.sent}`);

  // Mark step-1 engagement differently for each prospect before step 2 becomes due (wait is
  // 0 days/0 hours, so it's due immediately on the next tick).
  async function branchCpFor(prospect) {
    const cpRows = await Campaigns.listCampaignProspects(branchCampaign.insertId);
    return cpRows.find((r) => r.prospect_id === prospect.id);
  }
  async function markStep1EngagementFor(prospect, { opened, clicked }) {
    const cp = await branchCpFor(prospect);
    const sendRow = (await dbIndex.query('SELECT * FROM sends WHERE campaign_prospect_id = ? AND step_order = 1', [cp.id]))[0];
    if (opened) await Sends.markOpened(sendRow.tracking_token);
    if (clicked) await Sends.markClicked(sendRow.tracking_token);
  }
  await markStep1EngagementFor(pBranchClicked, { opened: false, clicked: true });
  await markStep1EngagementFor(pBranchOpened, { opened: true, clicked: false });
  await markStep1EngagementFor(pBranchDefault, { opened: false, clicked: false });
  await markStep1EngagementFor(pBranchBoth, { opened: true, clicked: true }); // priority test: clicked must win

  // The global minimum-gap-between-emails-to-the-same-prospect guardrail (72h, set earlier in
  // this suite) would otherwise block step 2 from sending only seconds after step 1 - drop it
  // to 0 just for this run, then restore it, same pattern used elsewhere in this suite for
  // temporarily overriding a guardrail to exercise the next step of a flow.
  await Settings.set('min_hours_between_emails_to_same_prospect', '0');
  const branchSecondRun = await scheduler.runOnce({ ignoreWindow: true });
  await Settings.set('min_hours_between_emails_to_same_prospect', '72');
  check('branching campaign step 2 sent to all 4 prospects', branchSecondRun.sent === 4, `sent=${branchSecondRun.sent}`);

  async function step2StepRowUsedBy(prospect) {
    const cp = await branchCpFor(prospect);
    const sendRow = (await dbIndex.query('SELECT * FROM sends WHERE campaign_prospect_id = ? AND step_order = 2', [cp.id]))[0];
    return (await dbIndex.query('SELECT * FROM sequence_steps WHERE id = ?', [sendRow.sequence_step_id]))[0];
  }

  const clickedResolved = await step2StepRowUsedBy(pBranchClicked);
  check(
    'a prospect who clicked step 1 is sent the "clicked" branch template',
    clickedResolved.template_id === branchClickedTemplate.insertId && clickedResolved.branch_condition === 'clicked',
    JSON.stringify(clickedResolved)
  );

  const openedResolved = await step2StepRowUsedBy(pBranchOpened);
  check(
    'a prospect who only opened step 1 (never clicked) is sent the "opened" branch template',
    openedResolved.template_id === branchOpenedTemplate.insertId && openedResolved.branch_condition === 'opened',
    JSON.stringify(openedResolved)
  );

  const defaultResolved = await step2StepRowUsedBy(pBranchDefault);
  check(
    'a prospect who neither opened nor clicked step 1 is sent the default branch template',
    defaultResolved.template_id === branchDefaultTemplate.insertId && !defaultResolved.branch_condition,
    JSON.stringify(defaultResolved)
  );

  const bothResolved = await step2StepRowUsedBy(pBranchBoth);
  check(
    'a prospect who both opened AND clicked step 1 is sent the "clicked" branch (clicked outranks opened)',
    bothResolved.template_id === branchClickedTemplate.insertId && bothResolved.branch_condition === 'clicked',
    JSON.stringify(bothResolved)
  );

  // The activity log's "reason" on a branching send should name which branch fired, so the
  // live Activity feed can label it - null/absent for an ordinary non-branching send.
  const branchActivity = await ActivityLog.list({ limit: 500 });
  const clickedActivitySent = branchActivity.find((a) => a.event_type === 'sent' && a.prospect_email === 'branch-clicked@example.com' && a.step_order === 2);
  check('the activity log records which branch fired for a branching send', clickedActivitySent && clickedActivitySent.reason === 'clicked', JSON.stringify(clickedActivitySent));
  const defaultActivitySent = branchActivity.find((a) => a.event_type === 'sent' && a.prospect_email === 'branch-default@example.com' && a.step_order === 2);
  check('the default branch send logs no reason (same shape as an ordinary send)', defaultActivitySent && !defaultActivitySent.reason, JSON.stringify(defaultActivitySent));

  // --- Analytics.total_steps must count DISTINCT step_order, not raw sequence_steps rows -
  // this campaign has 4 rows (1 + 3 branches) across only 2 real steps. Caught as a latent bug
  // before it could manifest (see repo.js Analytics.forCampaign/perCampaign). ---
  const branchStats = await Analytics.forCampaign(branchCampaign.insertId);
  check('total_steps counts distinct step_order (2), not raw sequence_steps rows (4)', Number(branchStats.total_steps) === 2, JSON.stringify(branchStats));

  // --- Analytics.perCampaign: the Analytics page's "Campaigns" matrix needs the assigned
  // mailbox's email (so it's clear which inbox a campaign actually sends from) and the first
  // real send's timestamp (a "Start Date" - when the campaign actually began sending, not just
  // when the row was created). ---
  const perCampaignRows = await Analytics.perCampaign();
  const branchPerCampaignRow = perCampaignRows.find((r) => r.id === branchCampaign.insertId);
  check(
    'perCampaign reports the assigned mailbox\'s email as mailbox_emails',
    branchPerCampaignRow && branchPerCampaignRow.mailbox_emails === mailbox.email,
    JSON.stringify(branchPerCampaignRow)
  );
  check(
    'perCampaign reports first_sent_at (the earliest real send), not just last_sent_at',
    branchPerCampaignRow && !!branchPerCampaignRow.first_sent_at && branchPerCampaignRow.first_sent_at <= branchPerCampaignRow.last_sent_at,
    JSON.stringify({ first: branchPerCampaignRow.first_sent_at, last: branchPerCampaignRow.last_sent_at })
  );

  // --- stepActivity is grouped per sequence_steps row (one row per branch), by design - the
  // frontend aggregates the 3 branch rows sharing a step_order into one summary client-side.
  // Confirms each branch's own count stays separate and they sum to the 4 total step-2 sends. ---
  const branchStepActivity = await Campaigns.stepActivity(branchCampaign.insertId);
  const step2ActivityRows = branchStepActivity.filter((a) => a.step_order === 2);
  check('stepActivity returns one row per branch for the branching step (3 rows)', step2ActivityRows.length === 3, `${step2ActivityRows.length}`);
  const step2SentTotal = step2ActivityRows.reduce((sum, r) => sum + Number(r.sent_count), 0);
  check('the 3 branch rows\' sent counts sum to all 4 step-2 sends', step2SentTotal === 4, `${step2SentTotal}`);
  const clickedActivityRow = step2ActivityRows.find((a) => a.branch_condition === 'clicked');
  check('the "clicked" branch row alone reports 2 sends (branch-clicked + branch-both)', clickedActivityRow && Number(clickedActivityRow.sent_count) === 2, JSON.stringify(clickedActivityRow));

  // --- Deleting a branching step removes every row sharing its step_order, not just one branch. ---
  await Campaigns.removeStep(branchCampaign.insertId, clickedResolved.id);
  const branchStepsAfterDelete = await Campaigns.listSteps(branchCampaign.insertId);
  check(
    'deleting a branching step removes all of its branch rows, leaving only step 1',
    branchStepsAfterDelete.length === 1 && branchStepsAfterDelete[0].step_order === 1,
    `${branchStepsAfterDelete.length}`
  );

  // --- setStepBranches also covers the "convert back to simple" and "single branch" cases -
  // passing exactly one branch (condition: null) behaves identically to a plain addStep. ---
  const simpleConvertCampaign = await Campaigns.create('Branch-to-simple test campaign', 'pool', user.id);
  await Campaigns.addStep(simpleConvertCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStepBranches(simpleConvertCampaign.insertId, 2, {
    waitDays: 1, waitHours: 0, skipIfEngaged: false,
    branches: [{ condition: null, template_id: followupResult.insertId }]
  });
  const simpleConvertSteps = await Campaigns.listSteps(simpleConvertCampaign.insertId);
  check(
    'setStepBranches with a single default-only branch produces one plain (non-branching) row',
    simpleConvertSteps.filter((s) => s.step_order === 2).length === 1 && !simpleConvertSteps.find((s) => s.step_order === 2).branch_condition
  );

  // --- Campaigns.removeProspects: bulk "remove from this campaign only" - the recovery path
  // for accidentally adding the wrong list, or too many prospects, to one campaign. Removes
  // only this campaign's campaign_prospects row (and that row's sends) for each prospect - the
  // contact record itself, their membership in other campaigns, and their list membership are
  // all left untouched. ---
  const removeTestCampaignA = await Campaigns.create('Remove-prospects test campaign A', 'pool', user.id);
  await Campaigns.assignMailbox(removeTestCampaignA.insertId, mailbox.id);
  await Campaigns.addStep(removeTestCampaignA.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(removeTestCampaignA.insertId, 'active');

  const removeTestCampaignB = await Campaigns.create('Remove-prospects test campaign B', 'pool', user.id);

  const rpKeep = await Prospects.upsert({ email: 'remove-test-keep@example.com', first_name: 'Keep' });
  const rpGone1 = await Prospects.upsert({ email: 'remove-test-gone1@example.com', first_name: 'Gone1' });
  const rpGone2 = await Prospects.upsert({ email: 'remove-test-gone2@example.com', first_name: 'Gone2' });
  // rpGone1 is ALSO in campaign B and in a list, specifically to prove removing them from
  // campaign A doesn't touch either.
  await Campaigns.addProspects(removeTestCampaignA.insertId, [rpKeep.id, rpGone1.id, rpGone2.id]);
  await Campaigns.addProspects(removeTestCampaignB.insertId, [rpGone1.id]);
  const removeTestList = await Lists.create('Remove-prospects test list', 'General');
  await Lists.addProspects(removeTestList.insertId, [rpGone1.id]);

  // Generate a real send for everyone in campaign A first, to prove a removed prospect's sends
  // get cleaned up too, not just their campaign_prospects row.
  const removeTestRun = await scheduler.runOnce({ ignoreWindow: true });
  check('remove-prospects test campaign A sent to all 3 prospects before removal', removeTestRun.sent >= 3, `sent=${removeTestRun.sent}`);

  const cpRowsBeforeRemoval = await Campaigns.listCampaignProspects(removeTestCampaignA.insertId);
  const cpGone1Before = cpRowsBeforeRemoval.find((r) => r.prospect_id === rpGone1.id);
  const sendsGone1Before = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE campaign_prospect_id = ?', [cpGone1Before.id]))[0];
  check('rpGone1 has a send row in campaign A before being removed', sendsGone1Before.c >= 1);

  const removeResult = await Campaigns.removeProspects(removeTestCampaignA.insertId, [rpGone1.id, rpGone2.id]);
  check('removeProspects reports removing both targeted prospects', removeResult.removed === 2, JSON.stringify(removeResult));

  const cpRowsAfterRemoval = await Campaigns.listCampaignProspects(removeTestCampaignA.insertId);
  check(
    'campaign A now only has the kept prospect',
    cpRowsAfterRemoval.length === 1 && cpRowsAfterRemoval[0].prospect_id === rpKeep.id,
    `${cpRowsAfterRemoval.length}`
  );

  const sendsGone1After = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE campaign_prospect_id = ?', [cpGone1Before.id]))[0];
  check('removing a prospect from a campaign also deletes their sends in that campaign', sendsGone1After.c === 0);

  check("the removed prospect's contact record still exists", !!(await Prospects.get(rpGone1.id)));
  const cpInCampaignB = await Campaigns.listCampaignProspects(removeTestCampaignB.insertId);
  check('the removed prospect is untouched in a DIFFERENT campaign they were also in', cpInCampaignB.some((r) => r.prospect_id === rpGone1.id));
  const listMembersAfter = await Lists.listProspects(removeTestList.insertId);
  check('the removed prospect is untouched in a list they were also in', listMembersAfter.some((p) => p.id === rpGone1.id));

  const removeMissingResult = await Campaigns.removeProspects(removeTestCampaignA.insertId, [999999]);
  check('removing a prospect not actually in the campaign reports removed=0 instead of throwing', removeMissingResult.removed === 0, JSON.stringify(removeMissingResult));

  // --- Chunking: the IN-clause delete is chunked at 500 ids so a bulk correction of thousands
  // of prospects (the exact scenario this feature exists for) doesn't blow past SQLite/MySQL's
  // per-query parameter limits. Proven with a batch spanning 2 full chunks plus a partial one. ---
  const bulkCampaign = await Campaigns.create('Remove-prospects chunking test campaign', 'pool', user.id);
  const bulkProspectIds = [];
  for (let i = 0; i < 1200; i++) {
    const p = await Prospects.upsert({ email: `bulk-remove-${i}@example.com` });
    bulkProspectIds.push(p.id);
  }
  await Campaigns.addProspects(bulkCampaign.insertId, bulkProspectIds);
  const bulkCpBefore = await Campaigns.listCampaignProspects(bulkCampaign.insertId);
  check('bulk chunking test campaign has all 1200 prospects added', bulkCpBefore.length === 1200, `${bulkCpBefore.length}`);

  // --- listProspectIds / searchCampaignProspects: the lightweight-ids + paginated-table split
  // that replaced shipping all 1200 (or 20,000) prospects on every campaign-detail page load. ---
  const bulkIds = await Campaigns.listProspectIds(bulkCampaign.insertId);
  check('listProspectIds returns exactly the ids that were added, nothing more or less', bulkIds.length === 1200 && bulkProspectIds.every((id) => bulkIds.includes(id)), `${bulkIds.length}`);

  const bulkPage1 = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { page: 1, pageSize: 25 });
  check('page 1 returns exactly pageSize rows while total reflects the full 1200', bulkPage1.rows.length === 25 && bulkPage1.total === 1200, JSON.stringify({ rows: bulkPage1.rows.length, total: bulkPage1.total }));

  const bulkPage2 = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { page: 2, pageSize: 25 });
  check(
    'page 2 returns a different 25 rows than page 1 (real pagination, not the same page twice)',
    bulkPage2.rows.length === 25 && bulkPage2.rows[0].id !== bulkPage1.rows[0].id,
    JSON.stringify({ page1First: bulkPage1.rows[0]?.id, page2First: bulkPage2.rows[0]?.id })
  );

  const bulkLastPage = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { page: 48, pageSize: 25 });
  check('the last page (1200/25 = 48 pages) returns exactly the remaining rows', bulkLastPage.rows.length === 25, `${bulkLastPage.rows.length}`);

  const bulkOverPage = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { page: 999, pageSize: 25 });
  check('requesting a page past the end returns zero rows, not an error', bulkOverPage.rows.length === 0, `${bulkOverPage.rows.length}`);

  const bulkSearch = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { q: 'bulk-remove-7', page: 1, pageSize: 50 });
  check(
    'searching by partial email matches only the rows containing that substring',
    bulkSearch.total > 0 && bulkSearch.rows.every((r) => r.email.includes('bulk-remove-7')),
    JSON.stringify({ total: bulkSearch.total })
  );

  const bulkPageSizeCap = await Campaigns.searchCampaignProspects(bulkCampaign.insertId, { page: 1, pageSize: 10000 });
  check('an oversized page_size request is capped (at 200), not honored verbatim', bulkPageSizeCap.pageSize === 200 && bulkPageSizeCap.rows.length === 200, `pageSize=${bulkPageSizeCap.pageSize}, rows=${bulkPageSizeCap.rows.length}`);

  const bulkRemoveResult = await Campaigns.removeProspects(bulkCampaign.insertId, bulkProspectIds);
  check(
    'removing 1200 prospects (spanning multiple 500-id chunks) reports removed=1200',
    bulkRemoveResult.removed === 1200,
    JSON.stringify(bulkRemoveResult)
  );
  const bulkCpAfter = await Campaigns.listCampaignProspects(bulkCampaign.insertId);
  check('after bulk removal, the campaign has zero prospects left', bulkCpAfter.length === 0, `${bulkCpAfter.length}`);

  // --- Per-campaign daily send cap: setDailyCap / sentTodayCount. Independent of a mailbox's
  // own daily_cap - lets two campaigns sharing one mailbox each be capped without either one
  // starving the other (enforced in lib/scheduler.js's processOneDueProspect). sentTodayCount
  // is computed live from sends.sent_at rather than a stored/reset counter, so it self-resets
  // at the UTC day boundary with no separate reset job needed. ---
  const capCampaign = await Campaigns.create('Daily-cap test campaign', 'pool', user.id);
  const capCampaignRow = await Campaigns.get(capCampaign.insertId);
  check('a new campaign has no daily_cap set by default', capCampaignRow.daily_cap == null, `${capCampaignRow.daily_cap}`);

  await Campaigns.setDailyCap(capCampaign.insertId, 2);
  const capCampaignAfterSet = await Campaigns.get(capCampaign.insertId);
  check('setDailyCap persists the new cap', capCampaignAfterSet.daily_cap === 2, `${capCampaignAfterSet.daily_cap}`);

  const zeroSentCount = await Campaigns.sentTodayCount(capCampaign.insertId);
  check('sentTodayCount is 0 for a campaign with no sends yet', zeroSentCount === 0, `${zeroSentCount}`);

  const capProspects = [];
  for (let i = 0; i < 3; i++) {
    capProspects.push(await Prospects.upsert({ email: `daily-cap-${i}@example.com` }));
  }
  await Campaigns.addProspects(capCampaign.insertId, capProspects.map((p) => p.id));
  const capCps = await Campaigns.listCampaignProspects(capCampaign.insertId);

  // Two sends "sent" right now (today, UTC) should count toward today's total.
  await Sends.create(capCps[0].id, mailbox.id, 1, 'daily-cap-token-1');
  await Sends.create(capCps[1].id, mailbox.id, 1, 'daily-cap-token-2');
  const twoSentCount = await Campaigns.sentTodayCount(capCampaign.insertId);
  check('sentTodayCount counts sends made today', twoSentCount === 2, `${twoSentCount}`);

  // A send backdated to yesterday (UTC) must NOT count toward today's total - this is what
  // makes the cap self-reset at the UTC day boundary without any reset job.
  await require('./db/index').run(
    'UPDATE sends SET sent_at = ? WHERE tracking_token = ?',
    ['2000-01-01 00:00:00', 'daily-cap-token-2']
  );
  const afterBackdateCount = await Campaigns.sentTodayCount(capCampaign.insertId);
  check('sentTodayCount excludes sends from before today (self-resets at the UTC day boundary)', afterBackdateCount === 1, `${afterBackdateCount}`);

  await Sends.create(capCps[2].id, mailbox.id, 1, 'daily-cap-token-3');
  const backToTwoCount = await Campaigns.sentTodayCount(capCampaign.insertId);
  check('sentTodayCount reflects a fresh send made today alongside the backdated one', backToTwoCount === 2, `${backToTwoCount}`);

  await Campaigns.setDailyCap(capCampaign.insertId, null);
  const capCampaignAfterClear = await Campaigns.get(capCampaign.insertId);
  check('setDailyCap with null clears the cap back to "no campaign-level limit"', capCampaignAfterClear.daily_cap == null, `${capCampaignAfterClear.daily_cap}`);

  // --- Overlapping-tick guard: reproduces the real duplicate-send incident (a 2-step, 4-recipient
  // campaign sent step 1 ten times instead of four). server.js's cron fires runOnce() every 60
  // seconds regardless of whether the previous tick is still mid-send (each send has a pacing
  // delay), so without a guard a second tick would re-fetch the same still-due prospect and send
  // it again. Firing two runOnce() calls without awaiting the first in between (Promise.all)
  // simulates that overlap directly. ---
  const overlapCampaign = await Campaigns.create('Overlap-guard test campaign', 'pool', user.id);
  await Campaigns.assignMailbox(overlapCampaign.insertId, mailbox.id);
  await Campaigns.addStep(overlapCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(overlapCampaign.insertId, 'active');
  const prospectOverlap = await Prospects.upsert({ email: 'overlap-guard@example.com', first_name: 'Overlap' });
  await Campaigns.addProspects(overlapCampaign.insertId, [prospectOverlap.id]);

  const [overlapRunA, overlapRunB] = await Promise.all([
    scheduler.runOnce({ ignoreWindow: true }),
    scheduler.runOnce({ ignoreWindow: true })
  ]);
  const overlapResults = [overlapRunA, overlapRunB];
  const skippedAsAlreadyRunning = overlapResults.filter((r) => r.skipped && r.reason === 'already_running');
  const actuallyProcessed = overlapResults.filter((r) => !r.skipped);
  check(
    'exactly one of two overlapping runOnce() calls is skipped as already_running',
    skippedAsAlreadyRunning.length === 1,
    JSON.stringify(overlapResults)
  );
  check('the other overlapping call processes normally', actuallyProcessed.length === 1, JSON.stringify(overlapResults));

  const overlapSendsRows = await dbIndex.query(
    `SELECT s.* FROM sends s
     INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
     WHERE cp.campaign_id = ?`,
    [overlapCampaign.insertId]
  );
  check('the overlap-guard prospect was only sent once, not twice', overlapSendsRows.length === 1, `send_rows=${overlapSendsRows.length}`);

  const sequentialRunAfterOverlap = await scheduler.runOnce({ ignoreWindow: true });
  check('a normal sequential run after the guard releases is not itself skipped', sequentialRunAfterOverlap.skipped !== true, JSON.stringify(sequentialRunAfterOverlap));

  // --- Sequence-wide progress + auto-complete: a campaign used to stay 'active' forever with
  // no honest "done" state, and the old sent-vs-recipients progress check broke the moment a
  // 2nd+ step existed (see the real duplicate-send incident this session). A single-step,
  // single-recipient campaign makes it easy to drive all the way to "fully finished" and check
  // both the new Analytics fields and the auto-complete sweep in one pass. ---
  const progressCampaign = await Campaigns.create('Progress-bar test campaign', 'pool', user.id);
  await Campaigns.assignMailbox(progressCampaign.insertId, mailbox.id);
  await Campaigns.addStep(progressCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(progressCampaign.insertId, 'active');
  const progressProspect = await Prospects.upsert({ email: 'progress-bar@example.com', first_name: 'Progress' });
  await Campaigns.addProspects(progressCampaign.insertId, [progressProspect.id]);

  let progressStats = await Analytics.forCampaign(progressCampaign.insertId);
  check('a fresh campaign reports total_steps from its sequence', Number(progressStats.total_steps) === 1, JSON.stringify(progressStats));
  check('a fresh campaign reports the one recipient as applicable', Number(progressStats.applicable_recipients) === 1);
  check('a fresh campaign has not made any sequence progress yet', Number(progressStats.current_step_sum) === 0);
  check('a fresh campaign has one recipient still active (pending/in_progress)', Number(progressStats.active_recipients) === 1);
  check('a fresh, already-due campaign reports itself as overdue', Number(progressStats.overdue_count) === 1);

  await scheduler.runOnce({ ignoreWindow: true });

  progressStats = await Analytics.forCampaign(progressCampaign.insertId);
  check('after its only step sends, current_step_sum reaches total_steps * applicable_recipients (100% progress)', Number(progressStats.current_step_sum) === 1, JSON.stringify(progressStats));
  check('after its only step sends, nobody is left active', Number(progressStats.active_recipients) === 0);
  check('after its only step sends, nobody is left overdue', Number(progressStats.overdue_count) === 0);

  let progressCampaignRow = await Campaigns.get(progressCampaign.insertId);
  check('the campaign is still active immediately after its last send (sweep runs on the NEXT tick)', progressCampaignRow.status === 'active');

  // Uses scheduler.autoCompleteFinishedCampaigns() (not the bare repo function) since the audit
  // logging lives in that wrapper, same split as promoteScheduledCampaigns/campaign_activated.
  const completedSweep = await scheduler.autoCompleteFinishedCampaigns();
  check('the finished campaign appears in the auto-complete sweep', completedSweep.some((c) => c.id === progressCampaignRow.id), JSON.stringify(completedSweep));

  progressCampaignRow = await Campaigns.get(progressCampaign.insertId);
  check('the campaign is marked completed after the sweep', progressCampaignRow.status === 'completed');

  const completedAudit = (await AuditLog.forCampaign(progressCampaign.insertId)).find((a) => a.action === 'campaign_completed');
  check('a campaign_completed audit entry was recorded', !!completedAudit);

  const secondSweep = await scheduler.autoCompleteFinishedCampaigns();
  check('an already-completed campaign is not swept again', !secondSweep.some((c) => c.id === progressCampaignRow.id), JSON.stringify(secondSweep));

  // A campaign with a recipient still genuinely pending must never be swept, even if it has
  // others who are already done - the sweep is all-or-nothing per campaign, on purpose.
  const stillActiveCampaign = await Campaigns.create('Still-active test campaign', 'pool', user.id);
  await Campaigns.assignMailbox(stillActiveCampaign.insertId, mailbox.id);
  await Campaigns.addStep(stillActiveCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.setStatus(stillActiveCampaign.insertId, 'active');
  const stillPendingProspect = await Prospects.upsert({ email: 'still-pending@example.com', first_name: 'Pending' });
  await Campaigns.addProspects(stillActiveCampaign.insertId, [stillPendingProspect.id]);
  const sweepWithPending = await scheduler.autoCompleteFinishedCampaigns();
  check('a campaign with a still-pending recipient is not swept', !sweepWithPending.some((c) => c.id === stillActiveCampaign.insertId), JSON.stringify(sweepWithPending));

  // --- Campaign scheduling: a scheduled campaign auto-promotes to active once its start
  // time arrives, and stays put if that time hasn't come yet ---
  const { toSqlDatetime } = require('./lib/dates');
  const pastSqlTime = toSqlDatetime(new Date(Date.now() - 60000));
  const futureSqlTime = toSqlDatetime(new Date(Date.now() + 3600000));

  const dueCampaign = await Campaigns.create('Scheduled - due now', 'pool', user.id);
  await Campaigns.schedule(dueCampaign.insertId, pastSqlTime);
  let dueRow = await Campaigns.get(dueCampaign.insertId);
  check('scheduling a campaign sets status to scheduled', dueRow.status === 'scheduled');

  const futureCampaign = await Campaigns.create('Scheduled - not due yet', 'pool', user.id);
  await Campaigns.schedule(futureCampaign.insertId, futureSqlTime);

  const promoted = await scheduler.promoteScheduledCampaigns();
  check('promoteScheduledCampaigns promotes the due campaign', promoted.some((c) => c.id === dueCampaign.insertId));
  check('promoteScheduledCampaigns leaves the not-yet-due campaign alone', !promoted.some((c) => c.id === futureCampaign.insertId));

  dueRow = await Campaigns.get(dueCampaign.insertId);
  check('a due scheduled campaign becomes active', dueRow.status === 'active');
  const futureRow = await Campaigns.get(futureCampaign.insertId);
  check('a not-yet-due scheduled campaign stays scheduled', futureRow.status === 'scheduled');

  // The Timeline showed "Scheduled to start X" next to an activation entry timestamped a few
  // minutes later (whenever the cron tick actually ran) with no explanation, which looked like
  // the two times just disagreed. promoteScheduledCampaigns() must carry the original
  // scheduled_at into the campaign_activated audit event so the UI can explain the gap.
  const activatedEntry = (await AuditLog.list(20)).find((a) => a.action === 'campaign_activated' && JSON.parse(a.meta_json).campaign_id === dueCampaign.insertId);
  const activatedMeta = JSON.parse(activatedEntry.meta_json);
  check('campaign_activated audit event records the original scheduled_at', activatedMeta.scheduled_for === pastSqlTime, `expected ${pastSqlTime}, got ${activatedMeta.scheduled_for}`);

  // --- Ordering fix: a scheduled campaign must flip to 'active' the moment its scheduled
  // time passes even while we're currently outside the sending window - only the actual
  // per-prospect sending loop should wait for the window, not the status promotion itself.
  // A zero-width window (start === end) is deterministically "outside" for any real hour the
  // test happens to run at, so this doesn't depend on wall-clock timing. ---
  const orderingFixCampaign = await Campaigns.create('Promote outside window test', 'pool', user.id);
  await Campaigns.addStep(orderingFixCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.schedule(orderingFixCampaign.insertId, pastSqlTime);
  await Settings.set('send_window_start_hour', '5');
  await Settings.set('send_window_end_hour', '5');
  const outsideWindowRun = await scheduler.runOnce({});
  check(
    'runOnce reports being outside the send window',
    outsideWindowRun.skipped === true && outsideWindowRun.reason === 'outside_send_window',
    JSON.stringify(outsideWindowRun)
  );
  const orderingFixRow = await Campaigns.get(orderingFixCampaign.insertId);
  check('a due-scheduled campaign still promotes to active even while outside the send window', orderingFixRow.status === 'active');
  // Restore a normal window so nothing later in the suite is affected by this zero-width one.
  await Settings.set('send_window_start_hour', '0');
  await Settings.set('send_window_end_hour', '23');

  const cancelCampaign = await Campaigns.create('Schedule to cancel', 'pool', user.id);
  await Campaigns.schedule(cancelCampaign.insertId, futureSqlTime);
  await Campaigns.cancelSchedule(cancelCampaign.insertId);
  const cancelRow = await Campaigns.get(cancelCampaign.insertId);
  check('cancelling a schedule reverts to draft with no scheduled_at', cancelRow.status === 'draft' && !cancelRow.scheduled_at);

  // --- Deleting a sequence step: closes the step_order gap for the remaining steps, and
  // shifts down current_step for any prospect who'd already reached or passed the deleted
  // step, so their progress still lines up with the renumbered sequence (see
  // Campaigns.removeStep in repo.js). Covers four prospect states in one deletion: never
  // started, mid-sequence but before the deleted step, past the deleted step but not done,
  // and past the deleted step with nothing left (should end up completed). ---
  const stepDeleteCampaign = await Campaigns.create('Step deletion test', 'pool', user.id);
  const stepA = await Campaigns.addStep(stepDeleteCampaign.insertId, 1, templateResult.insertId, 1, false);
  const stepB = await Campaigns.addStep(stepDeleteCampaign.insertId, 2, templateResult.insertId, 3, false);
  const stepC = await Campaigns.addStep(stepDeleteCampaign.insertId, 3, templateResult.insertId, 5, false);

  const pNotStarted = await Prospects.upsert({ email: 'step-delete-not-started@example.com' });
  const pMidway = await Prospects.upsert({ email: 'step-delete-midway@example.com' });
  const pPastDeleted = await Prospects.upsert({ email: 'step-delete-past-deleted@example.com' });
  const pDoneAll = await Prospects.upsert({ email: 'step-delete-done-all@example.com' });

  const { rows: [cpNotStarted] } = await Campaigns.addProspects(stepDeleteCampaign.insertId, [pNotStarted.id]);
  const { rows: [cpMidway] } = await Campaigns.addProspects(stepDeleteCampaign.insertId, [pMidway.id]);
  const { rows: [cpPastDeleted] } = await Campaigns.addProspects(stepDeleteCampaign.insertId, [pPastDeleted.id]);
  const { rows: [cpDoneAll] } = await Campaigns.addProspects(stepDeleteCampaign.insertId, [pDoneAll.id]);

  // Fast-forward progress directly (the actual send loop is exercised elsewhere) - current_step
  // counts how many steps a prospect has already completed.
  await CampaignProspects.updateAfterSend(cpMidway.id, 1, futureSqlTime); // done with step A, waiting on B
  await CampaignProspects.updateAfterSend(cpPastDeleted.id, 2, futureSqlTime); // done with A and B, waiting on C
  await CampaignProspects.updateAfterSend(cpDoneAll.id, 3, futureSqlTime); // done with A, B and C - nothing left

  await Campaigns.removeStep(stepDeleteCampaign.insertId, stepB.insertId);

  const stepsAfterDelete = await Campaigns.listSteps(stepDeleteCampaign.insertId);
  check('deleting step B leaves exactly 2 steps', stepsAfterDelete.length === 2, `${stepsAfterDelete.length}`);
  check('step A keeps its identity and step_order after deletion', stepsAfterDelete[0].id === stepA.insertId && stepsAfterDelete[0].step_order === 1);
  check(
    'step C is renumbered to step_order 2, closing the gap left by B',
    stepsAfterDelete[1].id === stepC.insertId && stepsAfterDelete[1].step_order === 2 && stepsAfterDelete[1].wait_days === 5
  );

  const cpNotStartedAfter = await CampaignProspects.get(cpNotStarted.id);
  check('a prospect who never started is untouched by the deletion', cpNotStartedAfter.current_step === 0 && cpNotStartedAfter.status === 'pending');

  const cpMidwayAfter = await CampaignProspects.get(cpMidway.id);
  check(
    'a prospect who was before the deleted step keeps their progress count unchanged',
    cpMidwayAfter.current_step === 1 && cpMidwayAfter.status === 'in_progress'
  );

  const cpPastDeletedAfter = await CampaignProspects.get(cpPastDeleted.id);
  check(
    'a prospect who was past the deleted step has their progress shifted down by one, still pending the renumbered next step',
    cpPastDeletedAfter.current_step === 1 && cpPastDeletedAfter.status === 'in_progress'
  );

  const cpDoneAllAfter = await CampaignProspects.get(cpDoneAll.id);
  check(
    'a prospect with nothing left after the shift is marked completed instead of left dangling',
    cpDoneAllAfter.current_step === 2 && cpDoneAllAfter.status === 'completed' && !cpDoneAllAfter.next_due_at
  );

  const missingStep = await Campaigns.removeStep(stepDeleteCampaign.insertId, 999999);
  check('deleting a non-existent step returns null instead of throwing', missingStep === null);

  // --- Tags: reusable colored labels, many-to-many with campaigns ---
  const tagA = await Tags.create('Hiring - Tech', '#1D9E75');
  const tagB = await Tags.create('Priority', '#D4537E');
  const allTags = await Tags.list();
  check('created tags appear in Tags.list()', allTags.some((t) => t.id === tagA.insertId) && allTags.some((t) => t.id === tagB.insertId));

  const tagCampaign = await Campaigns.create('Tag test campaign', 'pool', user.id);
  await Campaigns.addTag(tagCampaign.insertId, tagA.insertId);
  await Campaigns.addTag(tagCampaign.insertId, tagB.insertId);
  const addedAgain = await Campaigns.addTag(tagCampaign.insertId, tagA.insertId); // duplicate assignment
  check('assigning the same tag twice is a no-op, not a duplicate row', addedAgain === false);

  let tagCampaignTags = await Campaigns.listTags(tagCampaign.insertId);
  check('a campaign can carry multiple tags', tagCampaignTags.length === 2, `${tagCampaignTags.length}`);

  const allAssignments = await Tags.allCampaignTags();
  check(
    'allCampaignTags returns every campaign->tag assignment in one shot',
    allAssignments.filter((a) => a.campaign_id === tagCampaign.insertId).length === 2
  );

  await Campaigns.removeTag(tagCampaign.insertId, tagA.insertId);
  tagCampaignTags = await Campaigns.listTags(tagCampaign.insertId);
  check(
    'removing one tag from a campaign leaves the other intact',
    tagCampaignTags.length === 1 && tagCampaignTags[0].id === tagB.insertId
  );

  // Deleting a tag globally must also drop it from any campaign still carrying it (no FK
  // cascade on SQLite - see Tags.remove).
  await Campaigns.addTag(tagCampaign.insertId, tagA.insertId);
  await Tags.remove(tagA.insertId);
  const tagsAfterGlobalDelete = await Campaigns.listTags(tagCampaign.insertId);
  check(
    'deleting a tag globally removes it from every campaign it was assigned to',
    tagsAfterGlobalDelete.length === 1 && tagsAfterGlobalDelete[0].id === tagB.insertId
  );
  check('the deleted tag no longer appears in Tags.list()', !(await Tags.list()).some((t) => t.id === tagA.insertId));

  // Deleting a campaign must also clean up its campaign_tags rows (extends the existing
  // cascade-delete coverage for sends/campaign_prospects/sequence_steps/campaign_mailboxes).
  await Campaigns.remove(tagCampaign.insertId);
  const orphanedAssignments = await Tags.allCampaignTags();
  check(
    'deleting a campaign removes its tag assignments too',
    !orphanedAssignments.some((a) => a.campaign_id === tagCampaign.insertId)
  );

  // --- Per-campaign send pace: overrides the global MIN/MAX_SECONDS_BETWEEN_SENDS for a
  // single campaign (e.g. a fast test campaign at 10-20s vs. the normal 45-180s default) ---
  const paceCampaign = await Campaigns.create('Fast test campaign', 'pool', user.id);
  await Campaigns.setSendInterval(paceCampaign.insertId, 10, 20);
  const paceRow = await Campaigns.get(paceCampaign.insertId);
  check('setSendInterval persists the custom min/max seconds', paceRow.min_seconds_between_sends === 10 && paceRow.max_seconds_between_sends === 20);

  const customDelayMs = scheduler.randomDelayMs({ min_seconds_between_sends: 10, max_seconds_between_sends: 20 });
  check('randomDelayMs respects a campaign-level override', customDelayMs >= 10000 && customDelayMs <= 20000, `${customDelayMs}ms`);

  const defaultDelayMs = scheduler.randomDelayMs({ min_seconds_between_sends: null, max_seconds_between_sends: null });
  const envMin = Number(process.env.MIN_SECONDS_BETWEEN_SENDS || 45) * 1000;
  const envMax = Number(process.env.MAX_SECONDS_BETWEEN_SENDS || 180) * 1000;
  check('randomDelayMs falls back to the global .env default when no override is set', defaultDelayMs >= envMin && defaultDelayMs <= envMax, `${defaultDelayMs}ms`);

  // --- Campaign duplication: clones sequence steps, mailboxes, tags, and the send pace
  // override into a fresh draft, and re-adds the same recipients through the ordinary
  // addProspects() - so a prospect who's since become globally suppressed (prospectB, marked
  // suppressed earlier in this suite) correctly lands as 'unsubscribed' in the copy rather
  // than being silently re-queued as pending just because this is a "duplicate" action. ---
  await Campaigns.assignMailbox(paceCampaign.insertId, mailbox.id);
  await Campaigns.addStep(paceCampaign.insertId, 1, templateResult.insertId, 0, false);
  await Campaigns.addStep(paceCampaign.insertId, 2, followupResult.insertId, 2, true, 5, 15);
  await Campaigns.addTag(paceCampaign.insertId, tagB.insertId);
  await Campaigns.addProspects(paceCampaign.insertId, [prospectA.id, prospectB.id]);

  const dup = await Campaigns.duplicate(paceCampaign.insertId, user.id);
  check('duplicate() returns the new campaign id and a "(Copy)" name', !!(dup && dup.id) && dup.name === 'Fast test campaign (Copy)', JSON.stringify(dup));

  const dupCampaign = await Campaigns.get(dup.id);
  check('the duplicated campaign starts as a draft with no schedule carried over', dupCampaign.status === 'draft' && !dupCampaign.scheduled_at);
  check('the duplicated campaign copies the send pace override', dupCampaign.min_seconds_between_sends === 10 && dupCampaign.max_seconds_between_sends === 20);

  const dupSteps = await Campaigns.listSteps(dup.id);
  check('the duplicated campaign has the same number of sequence steps', dupSteps.length === 2, `${dupSteps.length}`);
  check(
    'the duplicated steps carry over template/wait/skip settings in order',
    dupSteps[0].template_id === templateResult.insertId && dupSteps[0].wait_days === 0 &&
      dupSteps[1].template_id === followupResult.insertId && dupSteps[1].wait_days === 2 && dupSteps[1].wait_hours === 5 && dupSteps[1].wait_minutes === 15 && !!dupSteps[1].skip_if_engaged
  );

  const dupMailboxes = await Campaigns.listMailboxes(dup.id);
  check('the duplicated campaign keeps the same assigned mailbox', dupMailboxes.length === 1 && dupMailboxes[0].id === mailbox.id);

  const dupTags = await Campaigns.listTags(dup.id);
  check('the duplicated campaign keeps the same tags', dupTags.length === 1 && dupTags[0].id === tagB.insertId);

  const dupProspects = await Campaigns.listCampaignProspects(dup.id);
  const dupProspectA = dupProspects.find((p) => p.prospect_id === prospectA.id);
  const dupProspectB = dupProspects.find((p) => p.prospect_id === prospectB.id);
  check('the duplicated campaign re-adds the active prospect as pending, fresh at step 0', dupProspectA && dupProspectA.status === 'pending' && dupProspectA.current_step === 0);
  check('the duplicated campaign records the since-suppressed prospect as unsubscribed, not pending', dupProspectB && dupProspectB.status === 'unsubscribed');
  check('duplicate() reports the correct added/skipped-suppressed counts', dup.prospectsAdded === 1 && dup.prospectsSkippedSuppressed === 1, JSON.stringify(dup));

  const missingDup = await Campaigns.duplicate(999999, user.id);
  check('duplicating a non-existent campaign returns null instead of throwing', missingDup === null);

  // --- Rename + mailbox unassignment: the only two campaign-level edits that were still
  // missing (add-only mailbox assignment, no way to rename after creation) ---
  await Campaigns.rename(paceCampaign.insertId, 'Fast test campaign (renamed)');
  const renamedRow = await Campaigns.get(paceCampaign.insertId);
  check('rename() updates the campaign name', renamedRow.name === 'Fast test campaign (renamed)', renamedRow.name);

  let paceCampaignMailboxes = await Campaigns.listMailboxes(paceCampaign.insertId);
  check('paceCampaign has the mailbox assigned before testing removal', paceCampaignMailboxes.some((m) => m.id === mailbox.id));
  await Campaigns.removeMailbox(paceCampaign.insertId, mailbox.id);
  paceCampaignMailboxes = await Campaigns.listMailboxes(paceCampaign.insertId);
  check('removeMailbox() unassigns the mailbox from the campaign', !paceCampaignMailboxes.some((m) => m.id === mailbox.id));

  await Campaigns.setSendInterval(paceCampaign.insertId, null, null);
  const paceResetRow = await Campaigns.get(paceCampaign.insertId);
  check('setSendInterval(null, null) clears the override back to the account default', !paceResetRow.min_seconds_between_sends && !paceResetRow.max_seconds_between_sends);

  // --- Sending guardrails now live in the settings table (Settings, DB-backed) and take
  // priority over process.env everywhere in lib/scheduler.js - these prove the override is
  // actually read, not just saved. ---
  const seededSettings = await Settings.all();
  check('settings table is seeded with the historical default daily cap on init', seededSettings.default_daily_cap === '30');
  check('settings table is seeded with the historical warmup ramp length on init', seededSettings.warmup_ramp_days === '21');

  await Settings.set('min_seconds_between_sends', '10');
  await Settings.set('max_seconds_between_sends', '20');
  const settingsDelayMs = scheduler.randomDelayMs({ min_seconds_between_sends: null, max_seconds_between_sends: null }, await Settings.all());
  check('randomDelayMs uses the Settings-table pace when no campaign override is set', settingsDelayMs >= 10000 && settingsDelayMs <= 20000, `${settingsDelayMs}ms`);
  await Settings.set('min_seconds_between_sends', '0');
  await Settings.set('max_seconds_between_sends', '0.1');

  const noonUtc = new Date('2026-07-24T12:00:00Z'); // a Friday
  const narrowWindow = { ...(await Settings.all()), send_window_start_hour: '0', send_window_end_hour: '1', send_only_weekdays: 'false' };
  check('isWithinSendWindow returns false outside a Settings-configured window', scheduler.isWithinSendWindow(narrowWindow, noonUtc) === false);
  const wideWindow = { ...narrowWindow, send_window_start_hour: '0', send_window_end_hour: '23' };
  check('isWithinSendWindow returns true inside a Settings-configured window', scheduler.isWithinSendWindow(wideWindow, noonUtc) === true);

  // --- estimateEffectiveStart: the guardrail-aware "when will this actually start sending"
  // preview shown to users at schedule time, in the confirm modal, and on the campaigns list.
  const officeHours = { send_window_start_hour: '9', send_window_end_hour: '18', send_only_weekdays: 'false' };
  const officeHoursWeekdaysOnly = { ...officeHours, send_only_weekdays: 'true' };

  const withinWindowCandidate = new Date('2026-07-24T14:00:00Z'); // Friday, 2pm UTC
  const withinWindowEstimate = scheduler.estimateEffectiveStart(withinWindowCandidate, officeHours);
  check(
    'a candidate already inside the window is returned unchanged',
    withinWindowEstimate && withinWindowEstimate.getTime() === withinWindowCandidate.getTime()
  );

  const beforeWindowCandidate = new Date('2026-07-24T05:00:00Z'); // Friday, 5am UTC - too early
  const beforeWindowEstimate = scheduler.estimateEffectiveStart(beforeWindowCandidate, officeHours);
  check(
    'a candidate before today\'s window snaps to today\'s opening hour',
    beforeWindowEstimate && beforeWindowEstimate.toISOString() === '2026-07-24T09:00:00.000Z'
  );

  const afterWindowCandidate = new Date('2026-07-24T20:00:00Z'); // Friday, 8pm UTC - too late
  const afterWindowEstimateNoWeekdayLimit = scheduler.estimateEffectiveStart(afterWindowCandidate, officeHours);
  check(
    'a candidate after today\'s window (no weekday restriction) rolls to tomorrow\'s opening hour',
    afterWindowEstimateNoWeekdayLimit && afterWindowEstimateNoWeekdayLimit.toISOString() === '2026-07-25T09:00:00.000Z'
  );

  const afterWindowEstimateWeekdaysOnly = scheduler.estimateEffectiveStart(afterWindowCandidate, officeHoursWeekdaysOnly);
  check(
    'a candidate after Friday\'s window, weekdays-only, skips the weekend to Monday\'s opening hour',
    afterWindowEstimateWeekdaysOnly && afterWindowEstimateWeekdaysOnly.toISOString() === '2026-07-27T09:00:00.000Z'
  );

  const newMailboxDefaults = await Mailboxes.create({
    email: 'settings-default-check@kabilhirehq.com',
    display_name: 'Settings Default Check',
    smtp_host: 'smtp.gmail.com',
    smtp_user: 'x',
    smtp_pass_encrypted: 'x'
  });
  const newMailboxRow = await Mailboxes.get(newMailboxDefaults.insertId);
  check(
    'a new mailbox with no explicit cap picks up the Settings-table default_daily_cap',
    newMailboxRow.daily_cap === Number(seededSettings.default_daily_cap)
  );

  // --- Mailboxes.remove deletes a mailbox that has real send history, without tripping the
  // MySQL foreign key that (correctly) has no ON DELETE CASCADE for sends.mailbox_id - a real
  // bug hit in production: this used to be a plain DELETE FROM mailboxes with no child cleanup,
  // which SQLite silently allowed (no FK enforcement here) but MySQL rejected outright the
  // moment a mailbox had ever actually sent something. Deliberately scoped to only this
  // mailbox's own sends/campaign_mailboxes rows - the campaign and its OTHER mailbox
  // assignments/sends must survive untouched. ---
  const mailboxDeleteCampaign = await Campaigns.create('Mailbox-delete test campaign', 'pool', user.id);
  const mailboxDeleteProspect = await Prospects.upsert({ email: 'mailbox-delete-test@example.com', first_name: 'MBDelete' });
  await Campaigns.addProspects(mailboxDeleteCampaign.insertId, [mailboxDeleteProspect.id]);
  const mailboxDeleteCpRow = (await Campaigns.listCampaignProspects(mailboxDeleteCampaign.insertId))[0];

  const mailboxToDelete = await Mailboxes.create({
    email: 'mailbox-to-delete@kabilhirehq.com',
    display_name: 'Mailbox To Delete',
    smtp_host: 'smtp.gmail.com',
    smtp_user: 'x',
    smtp_pass_encrypted: 'x'
  });
  await Campaigns.assignMailbox(mailboxDeleteCampaign.insertId, mailboxToDelete.insertId);
  await Sends.create(mailboxDeleteCpRow.id, mailboxToDelete.insertId, 1, 'mailbox-delete-test-token');

  const sendsBeforeMailboxDelete = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE mailbox_id = ?', [mailboxToDelete.insertId]))[0];
  check('the mailbox has a real send row before being deleted', sendsBeforeMailboxDelete.c === 1);

  await Mailboxes.remove(mailboxToDelete.insertId);

  check('the mailbox itself is gone after removal', !(await Mailboxes.get(mailboxToDelete.insertId)));
  const sendsAfterMailboxDelete = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE mailbox_id = ?', [mailboxToDelete.insertId]))[0];
  check('removing a mailbox deletes its own send history', sendsAfterMailboxDelete.c === 0);
  const assignmentAfterMailboxDelete = (await dbIndex.query('SELECT COUNT(*) as c FROM campaign_mailboxes WHERE mailbox_id = ?', [mailboxToDelete.insertId]))[0];
  check('removing a mailbox deletes its campaign_mailboxes assignments', assignmentAfterMailboxDelete.c === 0);
  check(
    'the campaign that mailbox was assigned to, and its prospect, are untouched',
    !!(await Campaigns.get(mailboxDeleteCampaign.insertId)) && !!(await Prospects.get(mailboxDeleteProspect.id))
  );

  // --- Editing a contact touches only email/name/company ---
  const editTarget = await Prospects.upsert({ email: 'edit-target@example.com', first_name: 'Old' });
  await Prospects.update(editTarget.id, { email: 'edit-target-new@example.com', first_name: 'New', last_name: 'Name', company: 'Acme' });
  const editedRow = await Prospects.get(editTarget.id);
  check(
    'Prospects.update persists the new email, name and company',
    editedRow.email === 'edit-target-new@example.com' && editedRow.first_name === 'New' &&
      editedRow.last_name === 'Name' && editedRow.company === 'Acme'
  );

  // --- Deleting a contact cascades through sends, campaign_prospects and list_prospects ---
  // Reuses prospectA (founder.a@example.com), who by this point in the suite has already
  // received a real send in the "Kabilhire - SaaS founders" campaign and is checked here
  // before/after to prove Prospects.remove actually cleans up every table that references them,
  // not just the prospects row itself (see repo.js - no FK cascade in the SQLite schema).
  const cascadeList = await Lists.create('Cascade delete test list', 'General');
  await Lists.addProspects(cascadeList.insertId, [prospectA.id]);

  const cpRowsBefore = await Campaigns.listCampaignProspects(campaignResult.insertId);
  const cpRowBefore = cpRowsBefore.find((cp) => cp.email === 'founder.a@example.com');
  check('prospectA has a campaign_prospects row before deleting them', !!cpRowBefore);

  const sendsBefore = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE campaign_prospect_id = ?', [cpRowBefore.id]))[0];
  check('prospectA has at least one send row before deleting them', sendsBefore.c >= 1);

  const listRowsBefore = (await dbIndex.query('SELECT COUNT(*) as c FROM list_prospects WHERE prospect_id = ?', [prospectA.id]))[0];
  check('prospectA has a list_prospects row before deleting them', listRowsBefore.c === 1);

  await Prospects.remove(prospectA.id);

  check('a deleted prospect no longer exists', !(await Prospects.get(prospectA.id)));
  const sendsAfter = (await dbIndex.query('SELECT COUNT(*) as c FROM sends WHERE campaign_prospect_id = ?', [cpRowBefore.id]))[0];
  check('deleting a contact removes their send history', sendsAfter.c === 0);
  const cpAfter = (await dbIndex.query('SELECT COUNT(*) as c FROM campaign_prospects WHERE prospect_id = ?', [prospectA.id]))[0];
  check('deleting a contact removes their campaign_prospects rows', cpAfter.c === 0);
  const listRowsAfter = (await dbIndex.query('SELECT COUNT(*) as c FROM list_prospects WHERE prospect_id = ?', [prospectA.id]))[0];
  check('deleting a contact removes their list membership', listRowsAfter.c === 0);

  // --- Lists.rename + Lists.removeWithProspects: deleting a list permanently deletes every
  // prospect in it, by explicit design decision - including a prospect who's ALSO a member of
  // another list (they're deleted everywhere, not just unlinked from the deleted list). Set up
  // exactly the scenario that motivated this: listX and listY share one prospect (p2), plus one
  // prospect unique to each. ---
  const listXResult = await Lists.create('List X', 'General');
  const listYResult = await Lists.create('List Y', 'General');
  await Lists.rename(listXResult.insertId, 'List X (renamed)');
  const renamedListX = await Lists.get(listXResult.insertId);
  check('Lists.rename updates the list name', renamedListX.name === 'List X (renamed)', renamedListX.name);

  const p1OnlyX = await Prospects.upsert({ email: 'only-in-x@example.com', first_name: 'OnlyX' });
  const p2Shared = await Prospects.upsert({ email: 'shared-x-y@example.com', first_name: 'Shared' });
  const p3OnlyY = await Prospects.upsert({ email: 'only-in-y@example.com', first_name: 'OnlyY' });
  await Lists.addProspects(listXResult.insertId, [p1OnlyX.id, p2Shared.id]);
  await Lists.addProspects(listYResult.insertId, [p2Shared.id, p3OnlyY.id]);

  const { deletedProspectCount } = await Lists.removeWithProspects(listXResult.insertId);
  check('removeWithProspects reports the correct deleted count (both members of the deleted list)', deletedProspectCount === 2, `deletedProspectCount=${deletedProspectCount}`);
  check('the list itself no longer exists', !(await Lists.get(listXResult.insertId)));
  check('a prospect unique to the deleted list is gone entirely', !(await Prospects.get(p1OnlyX.id)));
  check(
    'a prospect shared with another list is ALSO deleted entirely - not just unlinked from the deleted list',
    !(await Prospects.get(p2Shared.id))
  );
  check('a prospect who was never in the deleted list is untouched', !!(await Prospects.get(p3OnlyY.id)));
  const listYMembersAfter = await Lists.listProspects(listYResult.insertId);
  check(
    'the surviving list no longer lists the now-deleted shared prospect as a member, but keeps its own unique one',
    listYMembersAfter.length === 1 && listYMembersAfter[0].email === 'only-in-y@example.com',
    JSON.stringify(listYMembersAfter)
  );

  // --- ActivityLog.list's afterId cursor is what the frontend's poll loop relies on to fetch
  // only new rows every few seconds instead of re-downloading the whole feed. ---
  const allActivitySoFar = await ActivityLog.list({ limit: 500 });
  const midpointId = allActivitySoFar[Math.floor(allActivitySoFar.length / 2)].id;
  const afterMidpoint = await ActivityLog.list({ afterId: midpointId, limit: 500 });
  check('afterId only returns rows newer than the given id', afterMidpoint.every((a) => a.id > midpointId), `midpoint=${midpointId}`);
  check('afterId returns rows in ascending id order (oldest of the new batch first)', afterMidpoint.every((a, i) => i === 0 || a.id > afterMidpoint[i - 1].id));
  const noNewActivity = await ActivityLog.list({ afterId: allActivitySoFar[allActivitySoFar.length - 1].id });
  check('afterId set to the newest known id returns nothing new yet', noNewActivity.length === 0);

  // --- LIMIT is interpolated directly into the SQL now (not bound as `?`), because mysql2's
  // prepared statements reject a placeholder there in production - this only ever showed up
  // against the real MySQL backend, never here against SQLite, which is exactly why the bug
  // shipped unnoticed. These checks aren't proof against MySQL specifically, but they do lock in
  // that the interpolation still respects the requested/capped limit correctly on either driver. ---
  const overCapActivity = await ActivityLog.list({ limit: 10000 });
  check('requesting more than the 200-row cap still returns at most 200 rows', overCapActivity.length <= 200, `got ${overCapActivity.length}`);
  const smallLimitActivity = await ActivityLog.list({ limit: 3 });
  check('a small explicit limit is respected', smallLimitActivity.length <= 3, `got ${smallLimitActivity.length}`);
  const overCapAudit = await AuditLog.list(10000);
  check('AuditLog.list also caps an over-large limit (at 500)', overCapAudit.length <= 500, `got ${overCapAudit.length}`);

  const activityStats = await ActivityLog.statsToday();
  check('statsToday counts at least the one real send from earlier in this run', activityStats.sent >= 1, JSON.stringify(activityStats));
  check('statsToday counts at least the one suppressed skip from earlier in this run', activityStats.skipped >= 1, JSON.stringify(activityStats));

  check('Campaigns.countActive counts only campaigns with status=active', (await Campaigns.countActive()) >= 1);
  const onlineMailboxes = await Mailboxes.countOnline();
  check('Mailboxes.countOnline reports online <= total', onlineMailboxes.online <= onlineMailboxes.total, JSON.stringify(onlineMailboxes));
  await Mailboxes.setStatus(mailbox.id, 'paused');
  const onlineAfterPause = await Mailboxes.countOnline();
  check('pausing a mailbox drops the online count by one', onlineAfterPause.online === onlineMailboxes.online - 1, JSON.stringify(onlineAfterPause));
  await Mailboxes.setStatus(mailbox.id, 'active');

  // --- AI template generation helpers (pure functions - no real OpenRouter network call) ---
  const { buildMessages, parseDraftResponse, DEFAULT_MODEL } = require('./lib/aiTemplates');

  check('DEFAULT_MODEL is a non-empty OpenRouter model id', typeof DEFAULT_MODEL === 'string' && DEFAULT_MODEL.includes('/'));

  const aiMessages = buildMessages({ prompt: 'Cold outreach to HR heads', tone: 'direct', length: 'medium', type: 'html' });
  check('buildMessages returns a system + user message pair', aiMessages.length === 2 && aiMessages[0].role === 'system' && aiMessages[1].role === 'user');
  check('buildMessages carries the prompt through to the user message', aiMessages[1].content === 'Cold outreach to HR heads');
  check('buildMessages bakes the requested tone into the system prompt', aiMessages[0].content.includes('Tone: direct'));
  check('buildMessages bakes the requested length into the system prompt', aiMessages[0].content.includes('Length: medium'));
  check('buildMessages asks for HTML body when type is html', aiMessages[0].content.includes('HTML'));
  check('buildMessages tells the model to use inline styles, not a <style> block, for HTML drafts', aiMessages[0].content.includes('inline style') && aiMessages[0].content.includes('never a <style> block'));
  check('buildMessages tells the model to avoid flexbox/grid for email-client compatibility', aiMessages[0].content.toLowerCase().includes('flexbox'));

  const textOnlyMessages = buildMessages({ prompt: 'x', tone: 'friendly', length: 'short', type: 'text' });
  check('buildMessages does NOT include the HTML-only styling instructions for plain-text drafts', !textOnlyMessages[0].content.includes('inline style'));

  const textDraft = parseDraftResponse(JSON.stringify({ name: 'Cold intro', subject: 'Quick question', body: 'Hi {{first_name}}' }), 'text');
  check('parseDraftResponse parses a well-formed JSON draft', textDraft.subject === 'Quick question' && textDraft.body_text === 'Hi {{first_name}}');
  check('parseDraftResponse routes plain-text body into body_text, not body_html', textDraft.body_html === '' && textDraft.type === 'text');

  const htmlDraft = parseDraftResponse(JSON.stringify({ name: 'HTML intro', subject: 'Hey there', body: '<p>Hi</p>' }), 'html');
  check('parseDraftResponse routes html body into body_html when type is html', htmlDraft.body_html === '<p>Hi</p>' && htmlDraft.body_text === '' && htmlDraft.type === 'html');

  const fencedDraft = parseDraftResponse('```json\n' + JSON.stringify({ subject: 'Fenced', body: 'text' }) + '\n```', 'text');
  check('parseDraftResponse strips markdown code fences some models add despite instructions', fencedDraft.subject === 'Fenced');

  const namelessDraft = parseDraftResponse(JSON.stringify({ subject: 'No name given', body: 'text' }), 'text');
  check('parseDraftResponse falls back to a default name when the model omits one', namelessDraft.name === 'AI-generated template');

  check('parseDraftResponse rejects malformed JSON with a friendly error', (() => {
    try { parseDraftResponse('not json at all', 'text'); return false; } catch (e) { return e.message.includes('draft'); }
  })());
  check('parseDraftResponse rejects a response missing subject/body', (() => {
    try { parseDraftResponse(JSON.stringify({ name: 'x' }), 'text'); return false; } catch (e) { return e.message.includes('missing'); }
  })());
  check('parseDraftResponse rejects an empty response', (() => {
    try { parseDraftResponse('', 'text'); return false; } catch (e) { return e.message.includes('empty'); }
  })());

  // --- OpenRouter key storage: same encrypt-at-rest path as mailbox SMTP passwords ---
  const orRawKey = 'sk-or-v1-test-key-1234';
  await Settings.set('openrouter_api_key_encrypted', encrypt(orRawKey));
  await Settings.set('openrouter_key_last4', orRawKey.slice(-4));
  const orSettings = await Settings.all();
  const { decrypt: decryptForTest } = require('./lib/crypto');
  check('openrouter API key round-trips through encrypt/decrypt via the settings table', decryptForTest(orSettings.openrouter_api_key_encrypted) === orRawKey);
  check('openrouter last-4 is stored alongside the encrypted key for masked display', orSettings.openrouter_key_last4 === '1234');
  // Reset so it doesn't leak into unrelated later assertions against Settings.all().
  await require('./db/index').run('DELETE FROM settings WHERE `key` IN (?, ?)', ['openrouter_api_key_encrypted', 'openrouter_key_last4']);

  // --- DNS verification mechanism (against a real public domain, just to prove the resolver logic works) ---
  // Capped at 4s: this sandbox's outbound network is restricted, so a hang here should not
  // block the rest of the suite - it only proves the dns.resolveTxt() call path is wired up
  // correctly, which is what routes/domains.js relies on in production.
  try {
    const dns = require('dns').promises;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    const txt = await withTimeout(dns.resolveTxt('gmail.com'), 4000);
    check('live DNS TXT lookup mechanism works (tested against gmail.com)', Array.isArray(txt) && txt.length > 0);
  } catch (e) {
    console.log(`SKIP - live DNS TXT lookup (sandbox network restriction, not a code defect): ${e.message}`);
  }

  // --- Summary ---
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED CHECKS:');
    failed.forEach((f) => console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exitCode = 1;
});

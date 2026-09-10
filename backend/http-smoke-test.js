// End-to-end HTTP verification: starts the real Express app on a test port and hits it with
// real requests (using Node's built-in fetch), to prove routing, auth middleware, security
// headers and the public tracking endpoints are wired correctly - not just the internal logic.
process.env.DB_DRIVER = 'sqlite';
process.env.TEST_MODE = 'true';
process.env.JWT_SECRET = 'http-smoke-test-secret';
process.env.CREDENTIAL_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.PORT = '4501';
process.env.BASE_URL = 'http://localhost:4501';
// Pin this explicitly so the scheduling tests' date math (which uses plain UTC-based
// Date methods) lines up with how the route interprets "wall clock" scheduled_at values -
// otherwise this would depend on whatever APP_TIMEZONE happens to be set in backend/.env.
process.env.APP_TIMEZONE = 'UTC';

const os = require('os');
const path = require('path');
const fs = require('fs');
const testDbPath = path.join(os.tmpdir(), 'techforce-http-smoke-test.sqlite');
try { fs.unlinkSync(testDbPath); } catch (e) {}

const sqliteDriver = require('./db/sqlite-driver');
sqliteDriver.init(testDbPath);
const dbIndex = require('./db/index');
dbIndex.init = async () => {};

const { app } = require('./server');
const { Settings } = require('./db/repo');
const scheduler = require('./lib/scheduler');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
}

const BASE = 'http://localhost:4501';

async function main() {
  const server = app.listen(4501);
  await new Promise((r) => setTimeout(r, 300));

  try {
    // Health check
    let res = await fetch(`${BASE}/api/health`);
    let json = await res.json();
    check('GET /api/health returns ok', res.status === 200 && json.ok === true);

    // Security headers from helmet
    check('helmet sets X-Content-Type-Options header', res.headers.get('x-content-type-options') === 'nosniff');
    check('helmet hides X-Powered-By header', res.headers.get('x-powered-by') === null);

    // First-run setup creates the admin account
    res = await fetch(`${BASE}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@techforceglobal.com', password: 'Sup3rSecret!', name: 'Bhavin Shah' })
    });
    json = await res.json();
    check('POST /api/auth/setup creates first admin and returns a token', res.status === 200 && !!json.token);
    const token = json.token;

    // Setup can't run twice
    res = await fetch(`${BASE}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someoneelse@techforceglobal.com', password: 'x', name: 'y' })
    });
    check('setup is blocked once an admin already exists', res.status === 400);

    // Wrong password rejected
    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@techforceglobal.com', password: 'wrong' })
    });
    check('login rejects wrong password with 401', res.status === 401);

    // Correct login works
    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@techforceglobal.com', password: 'Sup3rSecret!' })
    });
    json = await res.json();
    check('login succeeds with correct password', res.status === 200 && !!json.token);

    // Protected route rejects missing token
    res = await fetch(`${BASE}/api/auth/me`);
    check('protected route returns 401 with no token', res.status === 401);

    // Protected route accepts valid token
    res = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('protected route returns 200 with valid token', res.status === 200 && json.user.email === 'admin@techforceglobal.com');

    // Home page's two calls, on a completely fresh/empty account (this is exactly what
    // broke in the field: both must return clean 200s with zeroed-out data, not a 500).
    res = await fetch(`${BASE}/api/mailboxes/capacity-planner`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('capacity planner returns 200 on a fresh account with no mailboxes', res.status === 200 && json.safe_ceiling_today === 0);

    res = await fetch(`${BASE}/api/analytics/summary`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('analytics summary returns 200 on a fresh account with no sends', res.status === 200 && json.sent === 0);

    res = await fetch(`${BASE}/api/analytics/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('analytics campaigns returns 200 with an empty array on a fresh account', res.status === 200 && Array.isArray(json) && json.length === 0);

    // Mailbox creation + cap-editing round trip (PATCH /:id/caps)
    res = await fetch(`${BASE}/api/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        email: 'caps-test@kabilhirehq.com', display_name: 'Caps Test', smtp_host: 'smtp.gmail.com',
        smtp_port: 587, smtp_user: 'caps-test@kabilhirehq.com', smtp_password: 'x', daily_cap: 30
      })
    });
    json = await res.json();
    check('POST /api/mailboxes creates a mailbox', res.status === 200 && !!json.id);
    const mailboxId = json.id;

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/caps`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ warmup_start_cap: 100, daily_cap: 30 })
    });
    check('PATCH caps rejects warmup_start_cap higher than daily_cap (400)', res.status === 400);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/caps`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ warmup_start_cap: 30, daily_cap: 30 })
    });
    json = await res.json();
    check('PATCH caps accepts a valid update and returns the updated mailbox', res.status === 200 && json.warmup_start_cap === 30 && json.daily_cap === 30);

    res = await fetch(`${BASE}/api/mailboxes`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const updated = json.find((m) => m.id === mailboxId);
    check('updated mailbox now shows a day-0 safe cap equal to the new daily cap', updated.safe_cap_today === 30, `safe_cap_today=${updated.safe_cap_today}`);

    res = await fetch(`${BASE}/api/mailboxes/999999/caps`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daily_cap: 30 })
    });
    check('PATCH caps on a non-existent mailbox returns 404', res.status === 404);

    // Per-mailbox bounce/complaint capture method (AWS SES webhook vs. plain-SMTP IMAP polling -
    // see lib/bounceCapture.js and db/schema.*.sql's bounce_capture_method column comment).
    res = await fetch(`${BASE}/api/mailboxes`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const freshMailbox = json.find((m) => m.id === mailboxId);
    check('a freshly created mailbox defaults to bounce_capture_method=none', freshMailbox.bounce_capture_method === 'none', freshMailbox.bounce_capture_method);
    check('the mailbox list never exposes the encrypted IMAP password', freshMailbox.imap_pass_encrypted === undefined);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bounce_capture_method: 'not-a-real-method' })
    });
    check('PATCH bounce-capture rejects an unrecognized method (400)', res.status === 400);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bounce_capture_method: 'imap' })
    });
    check('PATCH bounce-capture rejects imap method with no host/username (400)', res.status === 400);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bounce_capture_method: 'imap', imap_host: 'imap.gmail.com', imap_user: 'caps-test@kabilhirehq.com' })
    });
    check('PATCH bounce-capture rejects imap method with no password on first save (400)', res.status === 400);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        bounce_capture_method: 'imap', imap_host: 'imap.gmail.com', imap_port: 993,
        imap_user: 'caps-test@kabilhirehq.com', imap_password: 'app-specific-password'
      })
    });
    json = await res.json();
    check(
      'PATCH bounce-capture accepts a full IMAP configuration and never echoes back the encrypted password',
      res.status === 200 && json.bounce_capture_method === 'imap' && json.imap_host === 'imap.gmail.com' && json.imap_pass_encrypted === undefined,
      JSON.stringify(json)
    );

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bounce_capture_method: 'ses' })
    });
    json = await res.json();
    check('switching back to ses succeeds without needing any IMAP fields', res.status === 200 && json.bounce_capture_method === 'ses', JSON.stringify(json));

    res = await fetch(`${BASE}/api/mailboxes/999999/bounce-capture`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bounce_capture_method: 'none' })
    });
    check('PATCH bounce-capture on a non-existent mailbox returns 404', res.status === 404);

    // Mailbox details editing round trip (PATCH /:id)
    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'caps-test@kabilhirehq.com', display_name: '', smtp_host: 'smtp.gmail.com', smtp_user: 'caps-test@kabilhirehq.com' })
    });
    check('PATCH details rejects a missing display name (400)', res.status === 400);

    res = await fetch(`${BASE}/api/mailboxes/${mailboxId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        email: 'caps-test@kabilhirehq.com', display_name: 'Renamed Caps Test',
        smtp_host: 'smtp-relay.brevo.com', smtp_port: 587, smtp_user: 'caps-test@kabilhirehq.com'
      })
    });
    json = await res.json();
    check('PATCH details updates display name and SMTP host without a new password', res.status === 200 && json.display_name === 'Renamed Caps Test' && json.smtp_host === 'smtp-relay.brevo.com');
    check('PATCH details response never includes the encrypted password', json.smtp_pass_encrypted === undefined);

    res = await fetch(`${BASE}/api/mailboxes/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'x@y.com', display_name: 'x', smtp_host: 'x', smtp_user: 'x' })
    });
    check('PATCH details on a non-existent mailbox returns 404', res.status === 404);

    // Template CRUD requires auth
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test template', type: 'text', subject: 'Hi {{first_name}}', body_text: 'Hello!' })
    });
    check('creating a template without auth is rejected (401)', res.status === 401);

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Test template', type: 'text', subject: 'Hi {{first_name}}', body_text: 'Hello!' })
    });
    json = await res.json();
    check('creating a template with auth succeeds', res.status === 200 && !!json.id);
    const testTemplateId = json.id;

    // Preview text (inbox preheader) is capped at 100 characters - most inbox clients only
    // display somewhere between 40-140 characters of it anyway, so this matches what's actually
    // useful rather than being an arbitrary UI restriction.
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Preview text too long', type: 'text', subject: 'Hi', body_text: 'Hello!', preview_text: 'A'.repeat(101) })
    });
    check('creating a template with a 101-character preview text is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/templates/${testTemplateId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Test template', type: 'text', subject: 'Hi {{first_name}}', body_text: 'Hello!', preview_text: 'B'.repeat(101) })
    });
    check('updating a template with a 101-character preview text is rejected (400)', res.status === 400);

    // Duplicate-name prevention: no two templates (or lists, or campaigns - tested further
    // below) may share a name. Case/whitespace-insensitive, so "test template" and
    // " Test Template " both collide with the "Test template" created just above.
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: ' test TEMPLATE ', type: 'text', subject: 'Different subject', body_text: 'Different body' })
    });
    check('creating a template with a duplicate name (different case/whitespace) is rejected (400)', res.status === 400);

    // Template deletion: an unused template can be deleted outright; a 404 for a bogus id;
    // "in use by a sequence step" is checked further below, once testTemplateId is actually
    // attached to a step.
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Throwaway template', subject: 'Throwaway subject', type: 'text', body_text: 'x' })
    });
    json = await res.json();
    const throwawayTemplateId = json.id;

    // Renaming (PUT, which replaces the whole template record including name) into a name
    // already used by another template is rejected the same way create is.
    res = await fetch(`${BASE}/api/templates/${throwawayTemplateId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Test template', subject: 'Throwaway subject', type: 'text', body_text: 'x' })
    });
    check('renaming a template to another template\'s name is rejected (400)', res.status === 400);

    // But saving a template's own unchanged name back to itself must NOT be treated as a
    // collision with itself - only re-check against every *other* template's name.
    res = await fetch(`${BASE}/api/templates/${throwawayTemplateId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Throwaway template', subject: 'Throwaway subject (edited)', type: 'text', body_text: 'x' })
    });
    json = await res.json();
    check('saving a template with its own existing name (no rename) succeeds', res.status === 200, `status=${res.status} body=${JSON.stringify(json)}`);

    res = await fetch(`${BASE}/api/templates/${throwawayTemplateId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting an unused template succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/templates/999999`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a non-existent template returns 404', res.status === 404);

    // No server-side length cap on the campaign name - a long name is meant to be stored in
    // full and only truncated for display (see truncateName() in Campaigns.jsx), with the full
    // name available on hover. This confirms a name well past the old 30-character UI display
    // width still round-trips through create/rename/fetch untouched, character for character.
    const longName = 'KabilHire - Agency - Recruitment outreach long name test';
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: longName, sending_mode: 'pool' })
    });
    check('creating a campaign with a long (58-character) name succeeds', res.status === 200);
    const longNameCampaignId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${longNameCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the long name is stored and returned in full, not truncated', json.name === longName, json.name);

    const renamedLongName = `${longName} renamed`;
    res = await fetch(`${BASE}/api/campaigns/${longNameCampaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: renamedLongName })
    });
    check('renaming a campaign to an even longer name succeeds', res.status === 200);

    // Sequence step deletion: route wiring + 404 for a step that doesn't exist. The full
    // renumbering/progress-shifting logic is covered at the repo level in smoke-test.js -
    // this just proves the HTTP route is wired to it correctly.
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Step delete route test', sending_mode: 'pool' })
    });
    json = await res.json();
    const stepDeleteCampaignId = json.id;

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: testTemplateId, wait_days: 1 })
    });
    check('adding sequence step 1 succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 2, template_id: testTemplateId, wait_days: 2 })
    });
    check('adding sequence step 2 succeeds', res.status === 200);

    // wait_hours: a step can wait a partial day (e.g. "2 hours later") instead of only
    // whole-day gaps. Omitting it defaults to 0 hours (backward compatible with older clients).
    // Uses its own throwaway campaign so it doesn't disturb stepDeleteCampaignId's step count,
    // which the deletion/renumbering checks just below depend on.
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'wait_hours API test', sending_mode: 'pool' })
    });
    const waitHoursCampaignId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: testTemplateId, wait_days: 0 })
    });
    check('adding a step without wait_hours succeeds (defaults to 0)', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 2, template_id: testTemplateId, wait_days: 0, wait_hours: 2 })
    });
    check('adding a step with wait_hours succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 3, template_id: testTemplateId, wait_days: 1, wait_hours: -3 })
    });
    check('adding a step with a negative wait_hours is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const hoursStep = json.steps.find((s) => s.step_order === 2);
    check('the fetched step reflects wait_hours=2', hoursStep && Number(hoursStep.wait_hours) === 2, JSON.stringify(hoursStep));
    const noHoursStep = json.steps.find((s) => s.step_order === 1);
    check('a step created without wait_hours defaults to 0', noHoursStep && Number(noHoursStep.wait_hours) === 0, JSON.stringify(noHoursStep));

    // --- wait_minutes: same idea as wait_hours, one level finer - a step can wait a partial
    // hour (e.g. "30 minutes later") instead of only whole-hour/whole-day gaps. Uses its own
    // dedicated campaign rather than reusing waitHoursCampaignId, so it doesn't perturb that
    // campaign's step count (checked exactly elsewhere, e.g. in the duplicate-campaign test). ---
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'wait_minutes API test', sending_mode: 'pool' })
    });
    const waitMinutesCampaignId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${waitMinutesCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: testTemplateId, wait_days: 0 })
    });
    check('adding step 1 to the wait_minutes test campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitMinutesCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 2, template_id: testTemplateId, wait_days: 0, wait_hours: 1, wait_minutes: 30 })
    });
    check('adding a step with wait_minutes succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitMinutesCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 3, template_id: testTemplateId, wait_days: 1, wait_minutes: -15 })
    });
    check('adding a step with a negative wait_minutes is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${waitMinutesCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const minutesStep = json.steps.find((s) => s.step_order === 2);
    check(
      'the fetched step reflects both wait_hours=1 and wait_minutes=30',
      minutesStep && Number(minutesStep.wait_hours) === 1 && Number(minutesStep.wait_minutes) === 30,
      JSON.stringify(minutesStep)
    );
    const noMinutesStep = json.steps.find((s) => s.step_order === 1);
    check('a step created without wait_minutes defaults to 0', noMinutesStep && Number(noMinutesStep.wait_minutes) === 0, JSON.stringify(noMinutesStep));

    // Now that at least one campaign with a sequence step exists, confirm the new sequence-wide
    // progress fields (what the Campaigns list page's progress bar actually reads) reach the
    // real HTTP response shape, not just the repo function in isolation.
    res = await fetch(`${BASE}/api/analytics/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const waitHoursCampaignStats = json.find((c) => c.id === waitHoursCampaignId);
    check(
      'analytics campaigns includes the new sequence-progress fields for a real campaign',
      waitHoursCampaignStats
        && 'total_steps' in waitHoursCampaignStats
        && 'applicable_recipients' in waitHoursCampaignStats
        && 'current_step_sum' in waitHoursCampaignStats
        && 'active_recipients' in waitHoursCampaignStats
        && 'overdue_count' in waitHoursCampaignStats
        && Number(waitHoursCampaignStats.total_steps) === 2,
      JSON.stringify(waitHoursCampaignStats)
    );
    // Backs the Campaigns list page's "Running behind"/"Sending" info tooltip bullet list -
    // per-step sent counts (one entry per step_order, present even with 0 sends since it's a
    // LEFT JOIN off sequence_steps) and mailbox daily-cap headroom, merged in alongside the
    // existing per-campaign stats rather than requiring a separate round trip per row.
    check(
      'analytics campaigns includes a step_sent breakdown with one entry per real step',
      waitHoursCampaignStats
        && Array.isArray(waitHoursCampaignStats.step_sent)
        && waitHoursCampaignStats.step_sent.length === 2
        && waitHoursCampaignStats.step_sent.every((row) => 'step_order' in row && 'sent_count' in row),
      JSON.stringify(waitHoursCampaignStats.step_sent)
    );
    check(
      'analytics campaigns includes mailbox daily-cap headroom fields',
      waitHoursCampaignStats
        && 'active_daily_cap_total' in waitHoursCampaignStats
        && 'active_mailbox_count' in waitHoursCampaignStats
        && 'mailbox_count' in waitHoursCampaignStats,
      JSON.stringify(waitHoursCampaignStats)
    );

    // POST /:id/duplicate - clones sequence/mailboxes/tags/pace/recipients into a new draft.
    res = await fetch(`${BASE}/api/campaigns/999999/duplicate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('duplicating a non-existent campaign returns 404', res.status === 404);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/duplicate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'duplicating a real campaign returns the new id, a "(Copy)" name, and recipient counts',
      res.status === 200 && !!json.id && json.name === 'wait_hours API test (Copy)' && 'prospectsAdded' in json && 'prospectsSkippedSuppressed' in json,
      JSON.stringify(json)
    );
    const duplicatedCampaignId = json.id;

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the duplicated campaign starts as a draft', json.status === 'draft');
    check('the duplicated campaign has the same number of sequence steps as the original', json.steps.length === 2, `${json.steps.length}`);

    // Duplicate-name prevention (campaigns): creating one directly with a name already in use
    // is rejected the same way templates are, above.
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '  WAIT_HOURS api test  ', sending_mode: 'pool' })
    });
    check('creating a campaign with a duplicate name (different case/whitespace) is rejected (400)', res.status === 400);

    // Campaign names are unique, so duplicating the SAME source campaign a second time can't
    // reuse "(Copy)" again (that name is now taken by duplicatedCampaignId) - it must count up
    // to "(Copy 2)" instead of failing or colliding.
    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/duplicate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'duplicating the same campaign a second time avoids the name collision with "(Copy 2)"',
      res.status === 200 && json.name === 'wait_hours API test (Copy 2)',
      JSON.stringify(json)
    );

    // Timeline (audit log) shows the cross-link on both sides, not just the new copy.
    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    const dupTimeline = (await res.json()).timeline || [];
    check('the duplicated campaign\'s timeline records where it was duplicated from', dupTimeline.some((t) => t.action === 'campaign_duplicated' && t.meta.source_campaign_id === Number(waitHoursCampaignId)), JSON.stringify(dupTimeline));

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    const sourceTimeline = (await res.json()).timeline || [];
    check('the source campaign\'s timeline records the duplicate that was made from it', sourceTimeline.some((t) => t.action === 'campaign_duplicated' && t.meta.new_campaign_id === duplicatedCampaignId), JSON.stringify(sourceTimeline));

    // PATCH /:id - rename. Reuses the duplicated campaign so its own name (with " (Copy)")
    // doesn't matter to anything else in the suite.
    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '   ' })
    });
    check('renaming to a blank/whitespace-only name is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'whatever' })
    });
    check('renaming a non-existent campaign returns 404', res.status === 404);

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'wait_hours API test' })
    });
    check('renaming a campaign to another campaign\'s existing name is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'wait_hours API test (Copy)' })
    });
    check('saving a campaign with its own existing name (no rename) succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '  Renamed via HTTP test  ' })
    });
    json = await res.json();
    check('renaming a campaign succeeds and trims whitespace', res.status === 200 && json.name === 'Renamed via HTTP test', JSON.stringify(json));

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the rename is reflected on the next fetch', json.name === 'Renamed via HTTP test', json.name);

    // DELETE /:id/mailboxes/:mailboxId - unassign. Assigns the mailbox created earlier in
    // this suite (mailboxId) to the duplicated campaign specifically to test removing it.
    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    check('assigning a mailbox to the duplicated campaign succeeds (setup for the removal test below)', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}/mailboxes/${mailboxId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('unassigning a mailbox succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${duplicatedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the unassigned mailbox no longer appears on the campaign', !json.mailboxes.some((m) => m.id === mailboxId), JSON.stringify(json.mailboxes));

    // PATCH /:id/steps/:stepId - in-place edit of an existing step (template / wait days /
    // skip-if-engaged), as an alternative to delete-and-recreate. Reuses waitHoursCampaignId's
    // steps: step 1 (step_order 1, no wait) and step 2 (step_order 2, has a wait).
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'PATCH-step test template', subject: 'x', type: 'text', body_text: 'x' })
    });
    const patchTestTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const stepTwoId = json.steps.find((s) => s.step_order === 2).id;
    const stepOneId = json.steps.find((s) => s.step_order === 1).id;

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 5, wait_hours: 2, skip_if_engaged: true })
    });
    check('editing an existing step succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStep = json.steps.find((s) => s.id === stepTwoId);
    check(
      'the edited step reflects the new template, wait_days, and skip_if_engaged',
      editedStep && editedStep.template_id === patchTestTemplateId && Number(editedStep.wait_days) === 5 && !!Number(editedStep.skip_if_engaged),
      JSON.stringify(editedStep)
    );
    check('editing a non-first step honors the submitted wait_hours', editedStep && Number(editedStep.wait_hours) === 2, JSON.stringify(editedStep));

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 5, skip_if_engaged: true })
    });
    check('editing a non-first step without wait_hours succeeds (defaults to 0)', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStepNoHours = json.steps.find((s) => s.id === stepTwoId);
    check('omitting wait_hours on edit defaults it back to 0', editedStepNoHours && Number(editedStepNoHours.wait_hours) === 0, JSON.stringify(editedStepNoHours));

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepOneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 99, wait_hours: 5 })
    });
    check('editing step 1 succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStepOne = json.steps.find((s) => s.id === stepOneId);
    check(
      'editing step 1 still forces wait_days and wait_hours to 0 regardless of what was submitted',
      editedStepOne && Number(editedStepOne.wait_days) === 0 && Number(editedStepOne.wait_hours) === 0,
      JSON.stringify(editedStepOne)
    );

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 3 })
    });
    check('editing a step without a template_id is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 1, wait_hours: -5 })
    });
    check('editing a step with a negative wait_hours is rejected (400)', res.status === 400);

    // --- wait_minutes on PATCH: mirrors the wait_hours coverage above one level finer. ---
    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 5, wait_hours: 2, wait_minutes: 45, skip_if_engaged: true })
    });
    check('editing a step with wait_minutes succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStepMinutes = json.steps.find((s) => s.id === stepTwoId);
    check('editing a non-first step honors the submitted wait_minutes', editedStepMinutes && Number(editedStepMinutes.wait_minutes) === 45, JSON.stringify(editedStepMinutes));

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 5, skip_if_engaged: true })
    });
    check('editing a non-first step without wait_minutes succeeds (defaults to 0)', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStepNoMinutes = json.steps.find((s) => s.id === stepTwoId);
    check('omitting wait_minutes on edit defaults it back to 0', editedStepNoMinutes && Number(editedStepNoMinutes.wait_minutes) === 0, JSON.stringify(editedStepNoMinutes));

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepOneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 99, wait_hours: 5, wait_minutes: 40 })
    });
    check('editing step 1 with wait_minutes succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedStepOneMinutes = json.steps.find((s) => s.id === stepOneId);
    check(
      'editing step 1 still forces wait_minutes to 0 regardless of what was submitted',
      editedStepOneMinutes && Number(editedStepOneMinutes.wait_minutes) === 0,
      JSON.stringify(editedStepOneMinutes)
    );

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/${stepTwoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 1, wait_minutes: -10 })
    });
    check('editing a step with a negative wait_minutes is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/steps/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_id: patchTestTemplateId, wait_days: 1 })
    });
    check('editing a non-existent step returns 404', res.status === 404);

    // --- PUT /:id/steps/:stepOrder/branches: engagement branching. Covers every validation
    // rule in the route (repo-level branch-selection logic is already exhaustively covered in
    // smoke-test.js), then drives one real send-mark-send flow over HTTP to prove the whole
    // stack (route -> repo -> scheduler) is wired together correctly.
    // Fast pace up front - this section calls the real scheduler.runOnce(), which otherwise
    // paces sends 45-180s apart using the account default (the activity-feed section further
    // below sets this too, but only for itself, and runs after this block).
    await Settings.set('min_seconds_between_sends', '0');
    await Settings.set('max_seconds_between_sends', '0.1');
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branching HTTP test campaign', sending_mode: 'pool' })
    });
    const branchCampaignId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branch HTTP - step 1', subject: 'Step 1', type: 'text', body_text: 'Step 1 body' })
    });
    const branchStep1TemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branch HTTP - clicked', subject: 'Clicked', type: 'text', body_text: 'Thanks for clicking.' })
    });
    const branchClickedTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branch HTTP - opened', subject: 'Opened', type: 'text', body_text: 'Thanks for opening.' })
    });
    const branchOpenedTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branch HTTP - default', subject: 'Default', type: 'text', body_text: 'Just checking in.' })
    });
    const branchDefaultTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: branchStep1TemplateId, wait_days: 0 })
    });
    check('adding the branching campaign\'s step 1 (plain, non-branching) succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 0, wait_hours: 0, branches: [] })
    });
    check('PUT branches with an empty branches array is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_hours: 0, branches: [{ condition: null, template_id: branchDefaultTemplateId }] })
    });
    check('PUT branches without wait_days is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, wait_hours: -2, branches: [{ condition: null, template_id: branchDefaultTemplateId }] })
    });
    check('PUT branches with a negative wait_hours is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, wait_minutes: -20, branches: [{ condition: null, template_id: branchDefaultTemplateId }] })
    });
    check('PUT branches with a negative wait_minutes is rejected (400)', res.status === 400);

    // A successful branches PUT with wait_minutes round-trips correctly - checked here (before
    // the campaign is activated below) rather than on the final real 3-branch save further down,
    // since that save's wait must stay at 0 for the real send-timing assertions later in this
    // section to hold (a non-zero wait would delay step 2 past when those checks expect it).
    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, wait_hours: 2, wait_minutes: 20, branches: [{ condition: null, template_id: branchDefaultTemplateId }] })
    });
    check('a branches PUT with wait_minutes succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const branchWaitMinutesRow = json.steps.find((s) => s.step_order === 2);
    check(
      'the wait_minutes submitted on a branches PUT is persisted',
      branchWaitMinutesRow && Number(branchWaitMinutesRow.wait_minutes) === 20,
      JSON.stringify(branchWaitMinutesRow)
    );

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, branches: [{ condition: 'clicked' }] })
    });
    check('PUT branches with a branch missing a template_id is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, branches: [{ condition: 'replied', template_id: branchClickedTemplateId }] })
    });
    check('PUT branches with an invalid condition (not "opened"/"clicked") is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        wait_days: 1,
        branches: [
          { condition: 'clicked', template_id: branchClickedTemplateId },
          { condition: 'clicked', template_id: branchOpenedTemplateId }
        ]
      })
    });
    check('PUT branches with the same condition used twice is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/1/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        wait_days: 0,
        branches: [
          { condition: 'clicked', template_id: branchClickedTemplateId },
          { condition: null, template_id: branchDefaultTemplateId }
        ]
      })
    });
    check('PUT branches attempting to branch step 1 is rejected (400) - no previous step to check engagement on', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        wait_days: 1,
        branches: [
          { condition: 'clicked', template_id: branchClickedTemplateId },
          { condition: 'opened', template_id: branchOpenedTemplateId }
        ]
      })
    });
    check('PUT branches with multiple branches but no default (null) branch is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        wait_days: 0, wait_hours: 0,
        branches: [
          { condition: 'clicked', template_id: branchClickedTemplateId },
          { condition: 'opened', template_id: branchOpenedTemplateId },
          { condition: null, template_id: branchDefaultTemplateId }
        ]
      })
    });
    check('a valid 3-branch PUT succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const branchStep2Rows = json.steps.filter((s) => s.step_order === 2);
    check('the campaign detail response shows all 3 branch rows for step 2', branchStep2Rows.length === 3, `${branchStep2Rows.length}`);
    check(
      'the 3 branch rows carry the expected conditions',
      ['clicked', 'opened', null].every((c) => branchStep2Rows.some((s) => (s.branch_condition || null) === c)),
      JSON.stringify(branchStep2Rows.map((s) => s.branch_condition))
    );

    // Drive one real send -> mark-engagement -> send flow through the actual scheduler, over
    // HTTP end to end, to prove the route's saved branches are what the scheduler really reads.
    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    check('assigning a mailbox to the branching campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Branching HTTP test list' })
    });
    const branchListId = (await res.json()).id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'branch-http-clicked@example.com', first_name: 'ClickedHttp', list_id: branchListId })
    });
    const branchHttpClickedId = (await res.json()).id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'branch-http-default@example.com', first_name: 'DefaultHttp', list_id: branchListId })
    });
    const branchHttpDefaultId = (await res.json()).id;

    await fetch(`${BASE}/api/campaigns/${branchCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [branchHttpClickedId, branchHttpDefaultId] })
    });

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('the branching campaign activates once mailbox+steps+prospects are all in place', res.status === 200);

    await Settings.set('min_hours_between_emails_to_same_prospect', '0');
    const branchStep1Run = await scheduler.runOnce({ ignoreWindow: true });
    check('step 1 sends to both branching-flow prospects', branchStep1Run.sent === 2, `sent=${branchStep1Run.sent}`);

    const branchHttpClickedSend = (await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
       WHERE cp.campaign_id = ? AND cp.prospect_id = ? AND s.step_order = 1`,
      [branchCampaignId, branchHttpClickedId]
    ))[0];
    res = await fetch(`${BASE}/track/click/${branchHttpClickedSend.tracking_token}?u=https://example.com`, { redirect: 'manual' });
    check('marking the "clicked" prospect\'s step-1 send as clicked via the real /track/click route succeeds', res.status === 302);

    const branchStep2Run = await scheduler.runOnce({ ignoreWindow: true });
    await Settings.set('min_hours_between_emails_to_same_prospect', '72');
    check('step 2 sends to both branching-flow prospects', branchStep2Run.sent === 2, `sent=${branchStep2Run.sent}`);

    const branchHttpClickedStep2 = (await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
       WHERE cp.campaign_id = ? AND cp.prospect_id = ? AND s.step_order = 2`,
      [branchCampaignId, branchHttpClickedId]
    ))[0];
    const branchHttpClickedStepRow = (await dbIndex.query('SELECT * FROM sequence_steps WHERE id = ?', [branchHttpClickedStep2.sequence_step_id]))[0];
    check(
      'over the real HTTP-configured branches, a prospect who clicked step 1 is sent the "clicked" branch template',
      branchHttpClickedStepRow.template_id === branchClickedTemplateId && branchHttpClickedStepRow.branch_condition === 'clicked',
      JSON.stringify(branchHttpClickedStepRow)
    );

    const branchHttpDefaultStep2 = (await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
       WHERE cp.campaign_id = ? AND cp.prospect_id = ? AND s.step_order = 2`,
      [branchCampaignId, branchHttpDefaultId]
    ))[0];
    const branchHttpDefaultStepRow = (await dbIndex.query('SELECT * FROM sequence_steps WHERE id = ?', [branchHttpDefaultStep2.sequence_step_id]))[0];
    check(
      'over the real HTTP-configured branches, a prospect with no engagement is sent the default branch template',
      branchHttpDefaultStepRow.template_id === branchDefaultTemplateId && !branchHttpDefaultStepRow.branch_condition,
      JSON.stringify(branchHttpDefaultStepRow)
    );

    // PUT branches on a non-existent campaign - the route reaches setStepBranches directly
    // without first checking the campaign exists, so this proves it fails safely (no rows
    // written) rather than crashing with a 500.
    res = await fetch(`${BASE}/api/campaigns/999999/steps/2/branches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wait_days: 1, branches: [{ condition: null, template_id: branchDefaultTemplateId }] })
    });
    check('PUT branches on a non-existent campaign does not crash the server (not a 500)', res.status !== 500, `status=${res.status}`);

    // GET /:id/estimate-completion - the "how long will this whole campaign take" projection
    // shown in the Schedule/Send-now confirm popup. Reuses the branching campaign since it
    // already has a real mailbox, 2 sequence steps, and 2 real prospects assigned over HTTP.
    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/estimate-completion`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'estimate-completion reports the real prospect/step/mailbox counts for a live campaign',
      res.status === 200 && json.prospects_count === 2 && json.step_count === 2 && json.mailboxes_count === 1,
      JSON.stringify(json)
    );
    check('estimate-completion returns real completion dates, not null, when there is real sending capacity', !!json.step1_complete_at && !!json.full_sequence_complete_at, JSON.stringify(json));

    // The branching campaign above has, by this point in the run, actually already sent BOTH
    // real steps to BOTH real prospects (see branchStep1Run/branchStep2Run further up) - i.e.
    // its real current_step_sum already equals its full target (2 prospects x 2 steps = 4).
    // This is exactly the "campaign already mid-flight" case alreadyCompletedSteps exists for:
    // the projection should report it as done TODAY, not still counting toward some future date
    // as if nothing had been sent yet (which is what happened before this was wired through).
    const todayUtcStr = new Date().toISOString().slice(0, 10);
    check(
      "estimate-completion for a campaign that's already fully sent reports full_sequence_complete_at as today, not a stale future date ignoring real progress",
      json.full_sequence_complete_at === todayUtcStr && json.step1_complete_at === todayUtcStr,
      JSON.stringify(json)
    );

    res = await fetch(`${BASE}/api/campaigns/999999/estimate-completion`, { headers: { Authorization: `Bearer ${token}` } });
    check('estimate-completion for a non-existent campaign returns 404, not a 500', res.status === 404);

    res = await fetch(`${BASE}/api/campaigns/${branchCampaignId}/estimate-completion?at=not-a-real-date`, { headers: { Authorization: `Bearer ${token}` } });
    check('estimate-completion rejects an unparseable "at" date (400)', res.status === 400);

    // --- AI template generation (OpenRouter key in Settings + Templates "Generate with AI") ---
    res = await fetch(`${BASE}/api/settings/openrouter-key/status`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('openrouter-key status starts disconnected before any key is saved', res.status === 200 && json.connected === false, JSON.stringify(json));

    res = await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('GET /api/settings never leaks the encrypted openrouter key blob', !('openrouter_api_key_encrypted' in json));

    res = await fetch(`${BASE}/api/templates/generate-ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: '' })
    });
    check('generate-ai rejects an empty prompt (400)', res.status === 400);

    res = await fetch(`${BASE}/api/templates/generate-ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Cold outreach to HR heads' })
    });
    json = await res.json();
    check('generate-ai refuses to run with no OpenRouter key configured yet (400)', res.status === 400 && json.needsApiKey === true, JSON.stringify(json));

    res = await fetch(`${BASE}/api/settings/openrouter-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ api_key: 'sk-or-v1-fake-test-key-0000', model: 'openai/gpt-4o-mini' })
    });
    check('saving an openrouter API key succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/settings/openrouter-key/status`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('openrouter-key status reports connected + masked last4 + chosen model after saving', res.status === 200 && json.connected === true && json.last4 === '0000' && json.model === 'openai/gpt-4o-mini', JSON.stringify(json));

    // With a key configured, generate-ai will actually attempt the OpenRouter HTTP call - this
    // sandbox's outbound network is restricted (same caveat as the live DNS check below), so this
    // exercises the real fetch-failure error path rather than a genuine generation. Either a network
    // error (502, caught fetch rejection) or an upstream auth/HTTP error (502) is an acceptable,
    // non-crashing outcome for a fake key; a 500 would mean an unhandled exception and is not.
    res = await fetch(`${BASE}/api/templates/generate-ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Cold outreach to HR heads', tone: 'friendly', length: 'short', type: 'text' })
    });
    check('generate-ai with a configured (fake) key never crashes the server (no 500)', res.status !== 500, `status=${res.status}`);

    res = await fetch(`${BASE}/api/templates/${testTemplateId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a template still used by sequence steps is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const stepToDeleteId = json.steps[0].id;

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/steps/${stepToDeleteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    check('deleting sequence step 1 succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'the remaining step is renumbered to step_order 1 after deletion',
      json.steps.length === 1 && json.steps[0].step_order === 1
    );

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/steps/999999`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    check('deleting a non-existent step returns 404, not a 500', res.status === 404);

    // GET /:id/sends - read-only per-send detail (one row per email actually sent), used to
    // check a specific "I got this email twice" report precisely instead of only from the
    // aggregate per-step counts on the campaign detail response.
    res = await fetch(`${BASE}/api/campaigns/${waitHoursCampaignId}/sends`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('fetching sends for a campaign with none yet succeeds with an empty array', res.status === 200 && Array.isArray(json) && json.length === 0, JSON.stringify(json));

    res = await fetch(`${BASE}/api/campaigns/999999/sends`, { headers: { Authorization: `Bearer ${token}` } });
    check('fetching sends for a non-existent campaign returns 404, not a 500', res.status === 404);

    // Duplicate-name prevention (lists): same rule as templates/campaigns above - create,
    // then rename-collision, then confirm saving a list's own unchanged name is still fine.
    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Dup name test list' })
    });
    json = await res.json();
    check('creating a list succeeds', res.status === 200 && !!json.id);
    const dupListAId = json.id;

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: ' DUP name TEST list ' })
    });
    check('creating a list with a duplicate name (different case/whitespace) is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Dup name test list B' })
    });
    json = await res.json();
    const dupListBId = json.id;

    res = await fetch(`${BASE}/api/lists/${dupListBId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Dup name test list' })
    });
    check('renaming a list to another list\'s existing name is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/lists/${dupListAId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Dup name test list' })
    });
    check('saving a list with its own existing name (no rename) succeeds', res.status === 200);

    // Tags: create, assign to a campaign, list assignments, remove
    res = await fetch(`${BASE}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'HTTP test tag', color: '#378ADD' })
    });
    json = await res.json();
    check('creating a tag succeeds', res.status === 200 && !!json.id);
    const httpTagId = json.id;

    res = await fetch(`${BASE}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'HTTP test tag', color: '#D4537E' })
    });
    check('creating a tag with a duplicate name is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tag_id: httpTagId })
    });
    check('assigning a tag to a campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/tags/campaign-assignments`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'campaign-assignments includes the new tag for this campaign',
      json.some((a) => a.campaign_id === stepDeleteCampaignId && a.id === httpTagId)
    );

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the campaign detail response includes its tags', json.tags.some((t) => t.id === httpTagId));

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}/tags/${httpTagId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    check('removing a tag from a campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${stepDeleteCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the tag no longer appears on the campaign after removal', !json.tags.some((t) => t.id === httpTagId));

    res = await fetch(`${BASE}/api/tags/${httpTagId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a tag globally succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/tags/999999`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a non-existent tag returns 404, not a 500', res.status === 404);

    // Sending guardrails: these used to be fixed in backend/.env - now they're rows in the
    // settings table, seeded with the same historical defaults on first DB init, editable from
    // Settings in the UI, and enforced by the scheduler (lib/scheduler.js) at runtime.
    res = await fetch(`${BASE}/api/settings/guardrail-meta`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    // Was 13 - 3 fields (mailbox-level bounce rate, mailbox-level complaint rate, campaign-level
    // complaint rate) were intentionally removed from SENDING_GUARDRAILS by request, leaving only
    // the campaign-level bounce-rate guardrail from that group. See defaultSettings.js.
    check('guardrail-meta lists all 10 sending guardrails', Array.isArray(json) && json.length === 10, `got ${json.length}`);
    check('guardrail-meta entries carry a label and description', json.every((g) => g.key && g.label && g.description));

    res = await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('settings are seeded with the historical default daily cap (30)', json.default_daily_cap === '30');
    check('settings are seeded with the historical send window (9-20)', json.send_window_start_hour === '9' && json.send_window_end_hour === '20');
    check('settings are seeded with weekdays-only on by default', json.send_only_weekdays === 'true');

    res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ send_window_start_hour: 18, send_window_end_hour: 9 })
    });
    check('a send window end earlier than the start is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ min_seconds_between_sends: 100, max_seconds_between_sends: 20 })
    });
    check('a max delay lower than the min delay is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ warmup_start_cap: 50, default_daily_cap: 30 })
    });
    check('a warmup start cap higher than the default daily cap is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ auto_pause_bounce_rate_percent: 150 })
    });
    check('an out-of-range bounce rate percentage is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ send_window_start_hour: 8, send_window_end_hour: 21 })
    });
    check('a valid guardrail update succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the valid guardrail update is reflected on the next read', json.send_window_start_hour === '8' && json.send_window_end_hour === '21');

    // estimate-start: the guardrail-aware "when would sending actually begin" preview shown
    // at schedule time and in the confirm modal. Guardrails right now (from just above) are
    // an 8-21 window, weekdays only - a Saturday afternoon candidate should roll forward to
    // Monday's window-opening hour instead of staying put.
    res = await fetch(`${BASE}/api/campaigns/estimate-start?at=${encodeURIComponent('2026-07-25T14:00')}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a Saturday-afternoon candidate is reported as outside the send window', json.within_window === false);
    check('the estimate rolls a weekend candidate forward to Monday\'s window-opening hour', json.estimated_start_at === '2026-07-27 08:00:00', json.estimated_start_at);

    res = await fetch(`${BASE}/api/campaigns/estimate-start?at=${encodeURIComponent('2026-07-24T14:00')}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a Friday-afternoon candidate (inside the window) is reported as within the window', json.within_window === true);
    check('a within-window candidate\'s estimate matches the candidate itself', json.estimated_start_at === '2026-07-24 14:00:00', json.estimated_start_at);

    res = await fetch(`${BASE}/api/campaigns/estimate-start`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('estimate-start with no "at" defaults to right now and still returns the guardrail window', res.status === 200 && json.send_window_start_hour === 8 && json.send_window_end_hour === 21 && json.send_only_weekdays === true);

    res = await fetch(`${BASE}/api/campaigns/estimate-start?at=not-a-real-date`, { headers: { Authorization: `Bearer ${token}` } });
    check('estimate-start rejects an unparseable date/time (400)', res.status === 400);

    // Campaign scheduling: create a campaign, reject a past/missing date, accept a future one
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'HTTP scheduling test campaign', sending_mode: 'pool' })
    });
    json = await res.json();
    const schedCampaignId = json.id;

    // Readiness guard: a campaign with no mailbox and no sequence step must be rejected by
    // both /schedule and /activate, not just allowed to sit there silently never sending.
    const futureLocalGuardCheck = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scheduled_at: futureLocalGuardCheck })
    });
    check('scheduling a campaign with no mailbox and no steps is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    check('activating a campaign with no mailbox and no steps is rejected (400)', res.status === 400);

    // Now make it ready: assign the earlier test mailbox and a step, and confirm the guard
    // then gets out of the way for the rest of the scheduling flow below.
    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    check('assigning a mailbox to the scheduling-test campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: testTemplateId, wait_days: 1 })
    });
    check('adding a step to the scheduling-test campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    check('scheduling without a date is rejected (400)', res.status === 400);

    const pastLocal = new Date(Date.now() - 3600000).toISOString().slice(0, 16);
    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scheduled_at: pastLocal })
    });
    check('scheduling a past date/time is rejected (400)', res.status === 400);

    const futureLocal = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scheduled_at: futureLocal })
    });
    check('scheduling a future date/time succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('scheduled campaign reports status=scheduled with a scheduled_at value', json.status === 'scheduled' && !!json.scheduled_at);
    check('a scheduled campaign also carries a computed estimated_start_at', typeof json.estimated_start_at === 'string' && json.estimated_start_at.length > 0);

    res = await fetch(`${BASE}/api/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const schedRow = json.find((c) => c.id === schedCampaignId);
    check('the campaigns list also carries estimated_start_at for a scheduled campaign', schedRow && typeof schedRow.estimated_start_at === 'string');

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/unschedule`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    check('unscheduling succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('unscheduled campaign reverts to draft with no scheduled_at', json.status === 'draft' && !json.scheduled_at);

    // Per-campaign send pace: overrides the global send-gap default for one campaign
    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/send-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ min_seconds: 10, max_seconds: 20 })
    });
    check('setting a valid send pace succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('saved send pace is reflected on the campaign', json.min_seconds_between_sends === 10 && json.max_seconds_between_sends === 20);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/send-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ min_seconds: 3, max_seconds: 20 })
    });
    check('a send pace below the 5-second floor is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/send-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ min_seconds: 30, max_seconds: 20 })
    });
    check('a max lower than the min is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${schedCampaignId}/send-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ min_seconds: null, max_seconds: null })
    });
    check('clearing the send pace back to the account default succeeds', res.status === 200);

    // Prospects can now only be created attached to a list - this throwaway "intake" list
    // satisfies that requirement for the checks below that don't care which list a prospect
    // lands in (delete-flow cascade check, stats-check).
    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Smoke test intake list' })
    });
    json = await res.json();
    const intakeListId = json.id;

    // Deleting a campaign: there was previously no way to remove one at all. Give it a
    // prospect first so this also proves the cascade cleanup (campaign_prospects/sends/
    // sequence_steps/campaign_mailboxes) doesn't error or leave the campaign "stuck".
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Campaign to delete', sending_mode: 'pool' })
    });
    json = await res.json();
    const deleteCampaignId = json.id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'delete-me-too@example.com', first_name: 'Delete', list_id: intakeListId })
    });
    json = await res.json();
    const deleteProspectId = json.id;

    res = await fetch(`${BASE}/api/campaigns/${deleteCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [deleteProspectId] })
    });
    check('adding a prospect to the campaign-to-delete succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${deleteCampaignId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a campaign with a recipient already attached succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${deleteCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    check('a deleted campaign returns 404 afterward', res.status === 404);

    res = await fetch(`${BASE}/api/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a deleted campaign no longer appears in the campaign list', !json.some((c) => c.id === deleteCampaignId));

    res = await fetch(`${BASE}/api/campaigns/999999`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a non-existent campaign returns 404, not a 500', res.status === 404);

    // --- POST /:id/prospects/remove: bulk "remove from this campaign only" - the recovery path
    // for accidentally adding the wrong list/too many prospects. Repo-level cascade correctness
    // (sends cleaned up, other campaigns/lists untouched, chunking) is already exhaustively
    // covered in smoke-test.js - this proves the route itself is wired to it and validates input.
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Remove-prospects HTTP test', sending_mode: 'pool' })
    });
    const removeProspectsCampaignId = (await res.json()).id;

    const removeProspectsIds = [];
    for (const email of ['remove-http-keep@example.com', 'remove-http-gone1@example.com', 'remove-http-gone2@example.com']) {
      res = await fetch(`${BASE}/api/prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, list_id: intakeListId })
      });
      removeProspectsIds.push((await res.json()).id);
    }
    const [removeHttpKeepId, removeHttpGone1Id, removeHttpGone2Id] = removeProspectsIds;

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: removeProspectsIds })
    });
    check('adding all 3 prospects to the remove-prospects test campaign succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}/prospects/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [] })
    });
    check('removing with an empty prospect_ids array is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}/prospects/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    check('removing with no prospect_ids at all is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}/prospects/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [removeHttpGone1Id, removeHttpGone2Id] })
    });
    json = await res.json();
    check('removing 2 of the 3 prospects reports removed=2', res.status === 200 && json.removed === 2, JSON.stringify(json));

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'the campaign detail response now only lists the kept prospect id',
      Array.isArray(json.prospect_ids) && json.prospect_ids.length === 1 && json.prospect_ids[0] === removeHttpKeepId,
      JSON.stringify(json.prospect_ids)
    );

    res = await fetch(`${BASE}/api/campaigns/${removeProspectsCampaignId}/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'the paginated prospects endpoint agrees - only the kept prospect remains, with a real total',
      json.total === 1 && json.rows.length === 1 && json.rows[0].prospect_id === removeHttpKeepId,
      JSON.stringify(json)
    );

    res = await fetch(`${BASE}/api/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      "a removed prospect's contact record still exists (only their campaign membership was removed)",
      json.some((p) => p.id === removeHttpGone1Id) && json.some((p) => p.id === removeHttpGone2Id)
    );

    res = await fetch(`${BASE}/api/campaigns/999999/prospects/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [removeHttpKeepId] })
    });
    check('removing prospects from a non-existent campaign does not crash the server (not a 500)', res.status !== 500, `status=${res.status}`);

    // Prospects can only ever reach a campaign via a list, so creating one without a list_id
    // (or importing a CSV without one) must be rejected rather than silently creating an
    // orphan contact with no path into any campaign.
    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'no-list@example.com' })
    });
    check('creating a prospect without a list_id is rejected (400)', res.status === 400);

    const csvForm = new FormData();
    csvForm.append('file', new Blob(['email,first_name\nno-list-import@example.com,Test'], { type: 'text/csv' }), 'test.csv');
    res = await fetch(`${BASE}/api/prospects/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: csvForm
    });
    check('importing a CSV without a list_id is rejected (400)', res.status === 400);

    // Manual "add one" duplicate-in-list validation: same email in the SAME list a second time
    // must be rejected outright (not a silent no-op), but the same email in a DIFFERENT list is
    // a normal, allowed case.
    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Duplicate-check list A' })
    });
    const dupListA = (await res.json()).id;
    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Duplicate-check list B' })
    });
    const dupListB = (await res.json()).id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'dup-check@example.com', first_name: 'Dup', list_id: dupListA })
    });
    check('adding a brand-new contact to list A succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'dup-check@example.com', first_name: 'Dup', list_id: dupListA })
    });
    json = await res.json();
    check('re-adding the same email to the SAME list is rejected (400)', res.status === 400 && /already exists in this selected list/i.test(json.error || ''));

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'dup-check@example.com', first_name: 'Dup', list_id: dupListB })
    });
    check('adding the same email to a DIFFERENT list succeeds', res.status === 200);

    // Batch CSV import endpoint - the frontend parses the CSV itself and posts pre-parsed rows
    // here, so this exercises the four possible outcomes per row in one call: brand-new contact,
    // existing contact linked to a new list, existing contact already in this exact list
    // (skipped, no writes), and an invalid email.
    res = await fetch(`${BASE}/api/prospects/import-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rows: [{ email: 'batch-new@example.com', first_name: 'Batch' }] })
    });
    check('import-batch without a list_id is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/prospects/import-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ list_id: dupListA, rows: [] })
    });
    check('import-batch with no rows is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/prospects/import-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        list_id: dupListA,
        rows: [
          { email: 'batch-new@example.com', first_name: 'Batch' }, // brand new
          { email: 'dup-check@example.com', first_name: 'Dup' }, // exists, already in list A -> skipped
          { email: 'not-an-email', first_name: 'Bad' } // invalid
        ]
      })
    });
    json = await res.json();
    check(
      'import-batch reports correct per-row outcome counts',
      res.status === 200 && json.newContacts === 1 && json.alreadyInList === 1 && json.invalid === 1 && json.existingLinked === 0
    );

    res = await fetch(`${BASE}/api/lists/${dupListB}/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    res = await fetch(`${BASE}/api/prospects/import-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ list_id: dupListA, rows: [{ email: 'batch-new@example.com' }] }) // now exists (added above), not yet linked to list A a second time... already is, so this checks the "already in list" path for a contact created via import-batch itself
    });
    json = await res.json();
    check('re-importing the same batch-created email into the same list reports it as already-in-list', res.status === 200 && json.alreadyInList === 1 && json.newContacts === 0);

    // Prospects stats: total + new-in-30-days, used by the Home and Prospects page cards
    res = await fetch(`${BASE}/api/prospects/stats`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('prospects stats returns numeric total and new_last_30_days', res.status === 200 && typeof json.total === 'number' && typeof json.new_last_30_days === 'number');

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'stats-check@example.com', first_name: 'Stats', list_id: intakeListId })
    });
    check('adding a prospect for the stats check succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/prospects/stats`, { headers: { Authorization: `Bearer ${token}` } });
    const afterJson = await res.json();
    check('prospects stats total increments after adding one', afterJson.total === json.total + 1);
    check('a just-added prospect counts as new in the last 30 days', afterJson.new_last_30_days >= 1);

    // Lists: create, add a prospect, verify contact_count and membership round-trip
    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Test list', folder: 'Candidates' })
    });
    json = await res.json();
    check('creating a list succeeds', res.status === 200 && !!json.id);
    const listId = json.id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'list-member@example.com', first_name: 'List', last_name: 'Member', list_id: intakeListId })
    });
    json = await res.json();
    const prospectId = json.id;

    res = await fetch(`${BASE}/api/lists/${listId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [prospectId] })
    });
    json = await res.json();
    check('adding a prospect to a list succeeds', res.status === 200 && json.added === 1);

    res = await fetch(`${BASE}/api/lists`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const testList = json.find((l) => l.id === listId);
    check('list contact_count reflects the added prospect', testList && Number(testList.contact_count) === 1);

    res = await fetch(`${BASE}/api/lists/${listId}/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('listing a list\'s prospects returns the added member', res.status === 200 && json.length === 1 && json[0].email === 'list-member@example.com');

    // Editing and deleting a contact - email/name/company only, plus a permanent delete that
    // cascades through list membership (and campaign progress/sends, covered in smoke-test.js).
    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'edit-me@example.com', first_name: 'Before', list_id: intakeListId })
    });
    json = await res.json();
    const editProspectId = json.id;

    res = await fetch(`${BASE}/api/prospects/${editProspectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'edited@example.com', first_name: 'After', last_name: 'Edit', company: 'Acme' })
    });
    check('editing a contact succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const editedProspect = json.find((p) => p.id === editProspectId);
    check(
      'the edited contact shows its new email, name and company',
      editedProspect && editedProspect.email === 'edited@example.com' && editedProspect.first_name === 'After' &&
        editedProspect.last_name === 'Edit' && editedProspect.company === 'Acme'
    );

    res = await fetch(`${BASE}/api/prospects/${editProspectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'list-member@example.com', first_name: 'After' })
    });
    check('editing a contact to an email already used by another contact is rejected (400)', res.status === 400);

    res = await fetch(`${BASE}/api/prospects/999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'whatever@example.com' })
    });
    check('editing a non-existent contact returns 404, not a 500', res.status === 404);

    res = await fetch(`${BASE}/api/prospects/${editProspectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a contact succeeds', res.status === 200);

    res = await fetch(`${BASE}/api/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a deleted contact no longer appears in the contacts list', !json.some((p) => p.id === editProspectId));

    res = await fetch(`${BASE}/api/prospects/999999`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting a non-existent contact returns 404, not a 500', res.status === 404);

    // --- Send activity feed: build one real, sendable campaign end to end over the HTTP API
    // (template, list, prospect, campaign, step, mailbox, activate), then trigger a real send
    // in-process (there's no HTTP "send now" - only the cron/scheduler sends) so a genuine
    // tracking token exists to drive the public /track routes and check they log to the feed. ---
    await Settings.set('min_seconds_between_sends', '0');
    await Settings.set('max_seconds_between_sends', '0.1');

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Activity feed test template', type: 'text', folder: 'General',
        sender_name: 'Tester', subject: 'Hello {{first_name}}', preview_text: '',
        body_html: '', body_text: 'Hi {{first_name}}, this is a test.', status: 'active'
      })
    });
    json = await res.json();
    const activityTemplateId = json.id;
    check('POST /api/templates creates the activity-feed test template', res.status === 200 && !!activityTemplateId);

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Activity feed test list' })
    });
    json = await res.json();
    const activityListId = json.id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'activity-feed-test@example.com', first_name: 'Activity', list_id: activityListId })
    });
    json = await res.json();
    const activityProspectId = json.id;

    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Activity feed test campaign', sending_mode: 'pool' })
    });
    json = await res.json();
    const activityCampaignId = json.id;

    await fetch(`${BASE}/api/campaigns/${activityCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    await fetch(`${BASE}/api/campaigns/${activityCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: activityTemplateId, wait_days: 0 })
    });
    await fetch(`${BASE}/api/campaigns/${activityCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [activityProspectId] })
    });
    res = await fetch(`${BASE}/api/campaigns/${activityCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('the activity-feed test campaign activates once mailbox+step+prospect are all in place', res.status === 200);

    const activitySendResult = await scheduler.runOnce({ ignoreWindow: true });
    check('the in-process scheduler run actually sent the test email', activitySendResult.sent >= 1, JSON.stringify(activitySendResult));

    const activitySendRow = (await dbIndex.query(
      `SELECT s.* FROM sends s
       INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
       WHERE cp.campaign_id = ? ORDER BY s.id DESC LIMIT 1`,
      [activityCampaignId]
    ))[0];
    check('a real send row with a tracking token exists to test the public track routes against', !!activitySendRow && activitySendRow.tracking_token.length > 10);
    const activityToken = activitySendRow.tracking_token;

    res = await fetch(`${BASE}/track/open/${activityToken}.png`);
    check('open tracking pixel returns 200 for a real token', res.status === 200);

    res = await fetch(`${BASE}/track/click/${activityToken}?u=https://example.com/pricing`, { redirect: 'manual' });
    check('click tracking redirects to the destination url', res.status === 302 && res.headers.get('location') === 'https://example.com/pricing');

    res = await fetch(`${BASE}/track/webhook/bounce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: activityToken, type: 'soft' })
    });
    check('bounce webhook accepts a valid token', res.status === 200);

    // --- Real Amazon SES/SNS bounce+complaint capture (Task 2) - a dedicated prospect AND a
    // dedicated campaign, kept separate from activity-feed-test@example.com/activityCampaignId
    // above for two reasons: (1) the later unsubscribe-flow test still needs to land its own
    // fresh 'unsubscribed' suppression reason on that prospect, not get pre-empted by a
    // bounce/complaint reason landing first (Suppression.add keeps only the first reason recorded
    // for a given email); (2) the soft-bounce webhook call just above gave activityCampaignId a
    // 100% bounce rate on its only recipient - with the campaign-level bounce-rate auto-pause
    // judging the rate against total recipients with no minimum sample size (see
    // evaluateCampaignBounceHealth in lib/scheduler.js), reusing that campaign here would get it
    // re-paused by the very next tick's bulk sweep before it ever sent to a newly-added prospect,
    // no matter how many times it was reactivated. A brand-new campaign sidesteps that shared-state
    // poisoning entirely. Real SNS notifications only carry the recipient's email address, never
    // our tracking_token, so this exercises the actual match-by-email path
    // (Sends.findMostRecentUnbouncedByEmail) rather than the simplified {token,type} shape the
    // test above uses. ---
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'SES webhook test campaign' })
    });
    json = await res.json();
    const sesCampaignId = json.id;
    await fetch(`${BASE}/api/campaigns/${sesCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    await fetch(`${BASE}/api/campaigns/${sesCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: activityTemplateId, wait_days: 0 })
    });
    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'ses-webhook-test@example.com', first_name: 'SesWebhook', list_id: activityListId })
    });
    json = await res.json();
    const sesProspectId = json.id;
    await fetch(`${BASE}/api/campaigns/${sesCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [sesProspectId] })
    });
    res = await fetch(`${BASE}/api/campaigns/${sesCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('the dedicated SES-webhook test campaign activates', res.status === 200);

    const sesSendResult = await scheduler.runOnce({ ignoreWindow: true });
    check('a real send goes out for the dedicated SES-webhook test prospect', sesSendResult.sent >= 1, JSON.stringify(sesSendResult));

    const sesSendRowBefore = (await dbIndex.query(
      `SELECT s.* FROM sends s
       INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id
       INNER JOIN prospects p ON p.id = cp.prospect_id
       WHERE p.email = 'ses-webhook-test@example.com' ORDER BY s.id DESC LIMIT 1`
    ))[0];
    check('the dedicated send exists and is not yet bounced', !!sesSendRowBefore && !sesSendRowBefore.bounced_at);

    res = await fetch(`${BASE}/track/webhook/ses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({
          notificationType: 'Bounce',
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ses-webhook-test@example.com' }] }
        })
      })
    });
    json = await res.json();
    check('the SES/SNS webhook accepts a real Bounce notification and reports one processed', res.status === 200 && json.processed === 1, JSON.stringify(json));

    const sesSendRowAfter = (await dbIndex.query('SELECT * FROM sends WHERE id = ?', [sesSendRowBefore.id]))[0];
    check('the matched send is marked bounced with type=hard (Permanent)', !!sesSendRowAfter.bounced_at && sesSendRowAfter.bounce_type === 'hard', JSON.stringify(sesSendRowAfter));

    // /suppression-list now returns {rows, total, page, pageSize} (paginated/searchable, see
    // Suppression.search in db/repo.js) instead of a bare array - search by email so this
    // specific test row is found even if it isn't on the default first page.
    res = await fetch(`${BASE}/api/analytics/suppression-list?q=ses-webhook-test@example.com`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const sesSuppressionRow = json.rows.find((r) => r.email === 'ses-webhook-test@example.com');
    check('a hard bounce via the real SES webhook adds the email to the suppression list', !!sesSuppressionRow && sesSuppressionRow.reason === 'bounced', JSON.stringify(sesSuppressionRow));

    // SNS's one-time subscription handshake must be acknowledged without erroring, even though
    // there's no real SNS endpoint in this test environment to actually confirm against.
    res = await fetch(`${BASE}/track/webhook/ses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Type: 'SubscriptionConfirmation', TopicArn: 'arn:aws:sns:us-east-1:000000000000:fake-topic', SubscribeURL: 'https://example.com/does-not-exist' })
    });
    check('the SES webhook acknowledges an SNS SubscriptionConfirmation without erroring', res.status === 200);

    res = await fetch(`${BASE}/api/activity`);
    check('GET /api/activity without auth is rejected (401)', res.status === 401);

    res = await fetch(`${BASE}/api/activity?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('GET /api/activity returns an events array and a stats object', res.status === 200 && Array.isArray(json.events) && typeof json.stats === 'object');
    check('stats includes today\'s sent/skipped/bounced counts', typeof json.stats.sent === 'number' && typeof json.stats.bounced === 'number', JSON.stringify(json.stats));
    check('stats includes active campaign + mailbox-online counts', typeof json.stats.active_campaigns === 'number' && typeof json.stats.mailboxes_online === 'number', JSON.stringify(json.stats));

    // --- Scheduler tick history (getRecentTicks) - by this point in the test run, runOnce() has
    // already been called many times across the various campaign scenarios above, so this array
    // should be populated (and capped at 10) rather than empty. ---
    check('GET /api/activity includes a scheduler_ticks array', Array.isArray(json.scheduler_ticks));
    check('scheduler_ticks has accumulated real entries from earlier runOnce() calls, capped at 10', json.scheduler_ticks.length > 0 && json.scheduler_ticks.length <= 10, `count=${json.scheduler_ticks?.length}`);
    const lastTick = json.scheduler_ticks[json.scheduler_ticks.length - 1];
    check(
      'each tick entry has a timestamp and numeric processed/sent/skipped counts',
      !!lastTick && typeof lastTick.at === 'string' && typeof lastTick.processed === 'number' && typeof lastTick.sent === 'number' && typeof lastTick.skipped === 'number',
      JSON.stringify(lastTick)
    );

    const sentEvent = json.events.find((e) => e.event_type === 'sent' && e.prospect_email === 'activity-feed-test@example.com');
    const openedEvent = json.events.find((e) => e.event_type === 'opened' && e.prospect_email === 'activity-feed-test@example.com');
    const clickedEvent = json.events.find((e) => e.event_type === 'clicked' && e.prospect_email === 'activity-feed-test@example.com');
    const bouncedEvent = json.events.find((e) => e.event_type === 'bounced' && e.prospect_email === 'activity-feed-test@example.com');
    check('the feed includes the real "sent" event with the campaign name attached', sentEvent && sentEvent.campaign_name === 'Activity feed test campaign', JSON.stringify(sentEvent));
    check('the feed includes the "opened" event triggered via the real /track/open route', !!openedEvent);
    check('the feed includes the "clicked" event triggered via the real /track/click route', !!clickedEvent);
    check('the feed includes the "bounced" event triggered via the real webhook, with its reason', bouncedEvent && bouncedEvent.reason === 'soft', JSON.stringify(bouncedEvent));

    const newestEventId = json.events[json.events.length - 1].id;
    res = await fetch(`${BASE}/api/activity?after_id=${newestEventId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('polling with after_id set to the newest known id returns no new events yet', res.status === 200 && json.events.length === 0);

    // --- History search/export (/api/activity/search, /api/activity/export) - the paginated,
    // filterable browse added for digging through thousands of past events, separate from the
    // live-tail feed just tested above. Reuses the same real events from the activity-feed
    // campaign so every filter can be checked against a known, non-trivial result. ---
    res = await fetch(`${BASE}/api/activity/search`);
    check('GET /api/activity/search without auth is rejected (401)', res.status === 401);

    res = await fetch(`${BASE}/api/activity/search?q=activity-feed-test`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      'searching by prospect email returns the real events for that prospect, with a total count',
      res.status === 200 && Array.isArray(json.rows) && json.rows.length > 0 && json.rows.every((r) => r.prospect_email === 'activity-feed-test@example.com') && json.total >= json.rows.length,
      JSON.stringify({ total: json.total, rowCount: json.rows?.length })
    );

    res = await fetch(`${BASE}/api/activity/search?campaign_id=${activityCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('filtering by campaign_id returns only that campaign\'s rows', res.status === 200 && json.rows.length > 0 && json.rows.every((r) => r.campaign_id === activityCampaignId));

    res = await fetch(`${BASE}/api/activity/search?campaign_id=${activityCampaignId}&types=bounced`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('filtering by types=bounced returns only bounced rows', res.status === 200 && json.rows.length > 0 && json.rows.every((r) => r.event_type === 'bounced'));

    res = await fetch(`${BASE}/api/activity/search?campaign_id=${activityCampaignId}&page=1&page_size=1`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('page_size=1 returns exactly one row while total still reflects the full match count', res.status === 200 && json.rows.length === 1 && json.total > 1, JSON.stringify({ total: json.total, rowCount: json.rows.length }));

    res = await fetch(`${BASE}/api/activity/search?q=no-such-prospect-anywhere`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a search matching nothing returns an empty rows array and total=0, not an error', res.status === 200 && json.rows.length === 0 && json.total === 0);

    res = await fetch(`${BASE}/api/activity/export`);
    check('GET /api/activity/export without auth is rejected (401)', res.status === 401);

    res = await fetch(`${BASE}/api/activity/export?campaign_id=${activityCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    const csvText = await res.text();
    check('export responds with a CSV content-type and attachment filename', res.status === 200 && (res.headers.get('content-type') || '').includes('text/csv') && (res.headers.get('content-disposition') || '').includes('attachment'));
    check('the exported CSV has a friendly header row and includes the real prospect email', csvText.startsWith('Date/Time,Event,Campaign,') && csvText.includes('activity-feed-test@example.com'));

    // --- Unsubscribe happy path with a REAL, valid token - this only ever had the bad-token
    // 404 case covered before now, never proof that a genuine unsubscribe click actually
    // suppresses the prospect and stops their campaign. Reuses the same real send/token from
    // the activity-feed campaign above (safe to reuse - unsubscribing doesn't conflict with
    // the open/click/bounce checks already run against that same token). ---
    res = await fetch(`${BASE}/unsubscribe/${activityToken}`);
    const unsubHtml = await res.text();
    check('unsubscribing with a real token returns 200 with a confirmation page', res.status === 200 && unsubHtml.toLowerCase().includes('unsubscribed'));
    check('the confirmation page names the actual prospect email', unsubHtml.includes('activity-feed-test@example.com'));

    const suppressionRows = await dbIndex.query('SELECT * FROM suppression_list WHERE email = ?', ['activity-feed-test@example.com']);
    check('the prospect is added to the suppression list with reason=unsubscribed', suppressionRows.length === 1 && suppressionRows[0].reason === 'unsubscribed', JSON.stringify(suppressionRows[0]));
    check(
      'the suppression row records which real campaign the unsubscribe happened through',
      suppressionRows[0] && suppressionRows[0].campaign_name === 'Activity feed test campaign',
      JSON.stringify(suppressionRows[0])
    );

    res = await fetch(`${BASE}/api/analytics/suppression-list?q=activity-feed-test@example.com`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const unsubSuppressionApiRow = json.rows.find((s) => s.email === 'activity-feed-test@example.com');
    check(
      'the campaign name is also exposed through the suppression-list API (what the Settings page reads)',
      unsubSuppressionApiRow && unsubSuppressionApiRow.campaign_name === 'Activity feed test campaign',
      JSON.stringify(unsubSuppressionApiRow)
    );

    res = await fetch(`${BASE}/api/settings/suppression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'manually-blocked@example.com' })
    });
    check('manually blocking an email still works', res.status === 200);
    const manualSuppressionRows = await dbIndex.query('SELECT * FROM suppression_list WHERE email = ?', ['manually-blocked@example.com']);
    check(
      'a manually-blocked email has no campaign name attached (there is no campaign involved)',
      manualSuppressionRows[0] && manualSuppressionRows[0].campaign_name === null,
      JSON.stringify(manualSuppressionRows[0])
    );

    const unsubCpRows = await dbIndex.query('SELECT * FROM campaign_prospects WHERE campaign_id = ? AND prospect_id = ?', [activityCampaignId, activityProspectId]);
    check('the campaign_prospect row is marked unsubscribed, so no further steps will send to them', unsubCpRows[0] && unsubCpRows[0].status === 'unsubscribed', JSON.stringify(unsubCpRows[0]));
    check('the unsubscribed row has no next_due_at, so the scheduler will never pick it up again', unsubCpRows[0] && unsubCpRows[0].next_due_at === null);

    // --- DELETE /api/settings/suppression/:id (un-suppress) - this is the fix for a real bug
    // report: removing an email from the suppression list didn't clear the prospect's
    // denormalized is_suppressed flag anywhere, so Status kept reading "Suppressed" forever.
    // Reuses the real unsubscribed prospect from the activity-feed flow above. ---
    res = await fetch(`${BASE}/api/settings/suppression/999999`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting an unknown suppression id returns a clean 404', res.status === 404);

    res = await fetch(`${BASE}/api/analytics/suppression-list?q=activity-feed-test@example.com`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    const activitySuppressionRow = json.rows.find((s) => s.email === 'activity-feed-test@example.com');
    check('the suppression list (via the API) includes the unsubscribed prospect with an id', !!activitySuppressionRow, JSON.stringify(activitySuppressionRow));

    res = await fetch(`${BASE}/api/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    let activityProspectRow = json.find((p) => p.email === 'activity-feed-test@example.com');
    check('before un-suppressing, GET /api/prospects shows is_suppressed=1', activityProspectRow && Number(activityProspectRow.is_suppressed) === 1, JSON.stringify(activityProspectRow));

    res = await fetch(`${BASE}/api/settings/suppression/${activitySuppressionRow.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('un-suppressing a real entry returns 200 with the removed email', res.status === 200 && json.email === 'activity-feed-test@example.com', JSON.stringify(json));

    res = await fetch(`${BASE}/api/analytics/suppression-list?q=activity-feed-test@example.com`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the suppression list no longer contains the un-suppressed email', !json.rows.some((s) => s.email === 'activity-feed-test@example.com'));

    res = await fetch(`${BASE}/api/prospects`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    activityProspectRow = json.find((p) => p.email === 'activity-feed-test@example.com');
    check('after un-suppressing, GET /api/prospects now shows is_suppressed=0 (the bug fix)', activityProspectRow && Number(activityProspectRow.is_suppressed) === 0, JSON.stringify(activityProspectRow));

    // Deleting the same id again (now already gone) is a clean 404, not a 500
    res = await fetch(`${BASE}/api/settings/suppression/${activitySuppressionRow.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    check('deleting an already-removed suppression id returns 404, not a crash', res.status === 404);

    // Public tracking pixel works even with a bogus token (never breaks the image in the inbox)
    res = await fetch(`${BASE}/track/open/does-not-exist.png`);
    check('open tracking pixel returns 200 image even for unknown token', res.status === 200 && res.headers.get('content-type') === 'image/png');

    // Unknown unsubscribe token is handled gracefully, not a server crash
    res = await fetch(`${BASE}/unsubscribe/does-not-exist`);
    check('unsubscribe with unknown token returns a clean 404, not a 500', res.status === 404);

    // --- Auto-reactivating a 'completed' campaign when new prospects are added -------------
    // A completed campaign only got that status because nothing was left pending for it, but
    // the scheduler's listDue() only ever looks at status='active' campaigns - so without this
    // fix, prospects added after completion would sit as 'pending' forever, never picked up.
    // Builds its own tiny one-step/one-mailbox/one-prospect campaign, runs it to completion for
    // real via the scheduler, then adds a second prospect and checks the campaign comes back
    // to life on its own.
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Reactivation test template', type: 'text', folder: 'General',
        sender_name: 'Tester', subject: 'Hello {{first_name}}', preview_text: '',
        body_html: '', body_text: 'Hi {{first_name}}, this is a test.', status: 'active'
      })
    });
    const reactivationTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Reactivation test list' })
    });
    const reactivationListId = (await res.json()).id;

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'reactivation-first@example.com', first_name: 'First', list_id: reactivationListId })
    });
    const reactivationFirstProspectId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Reactivation test campaign', sending_mode: 'pool' })
    });
    const reactivationCampaignId = (await res.json()).id;

    await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [mailboxId] })
    });
    await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: reactivationTemplateId, wait_days: 0 })
    });
    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [reactivationFirstProspectId] })
    });
    json = await res.json();
    check('adding prospects to a brand-new (draft) campaign never reports reactivated', json.reactivated === false, JSON.stringify(json));

    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('the reactivation-test campaign activates once mailbox+step+prospect are all in place', res.status === 200);

    const reactivationSendRun = await scheduler.runOnce({ ignoreWindow: true });
    check('the scheduler sends the single step to the single prospect', reactivationSendRun.sent >= 1, JSON.stringify(reactivationSendRun));

    // Nothing left pending for this campaign now - the next tick's autoCompleteFinishedCampaigns
    // sweep (called inside runOnce) should flip it from active to completed on its own.
    await scheduler.runOnce({ ignoreWindow: true });
    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the campaign is auto-completed once its only prospect has nothing left pending', json.status === 'completed', `status=${json.status}`);

    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'reactivation-second@example.com', first_name: 'Second', list_id: reactivationListId })
    });
    const reactivationSecondProspectId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [reactivationSecondProspectId] })
    });
    json = await res.json();
    check(
      'adding a genuinely new prospect to a completed campaign reports reactivated=true',
      res.status === 200 && json.added === 1 && json.reactivated === true,
      JSON.stringify(json)
    );

    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the campaign itself is back to active status after the new prospect was added', json.status === 'active', `status=${json.status}`);

    const reactivationAuditRows = (await dbIndex.query(
      "SELECT * FROM audit_log WHERE action = 'campaign_reactivated_for_new_prospects'"
    )).filter((r) => String(JSON.parse(r.meta_json || '{}').campaign_id) === String(reactivationCampaignId));
    check('a campaign_reactivated_for_new_prospects audit entry was recorded', reactivationAuditRows.length === 1, JSON.stringify(reactivationAuditRows));

    // A manually paused campaign is a deliberate stop, not "finished" - adding a genuinely new
    // prospect to it must NOT auto-resume sending behind the user's back.
    await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/pause`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'reactivation-third@example.com', first_name: 'Third', list_id: reactivationListId })
    });
    const reactivationThirdProspectId = (await res.json()).id;
    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [reactivationThirdProspectId] })
    });
    json = await res.json();
    check('adding a new prospect to a manually PAUSED campaign adds it but does not reactivate', json.added === 1 && json.reactivated === false, JSON.stringify(json));
    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('a manually paused campaign stays paused when a new prospect is added to it', json.status === 'paused', `status=${json.status}`);

    // Re-adding an already-present prospect (no genuinely new rows) must never reactivate.
    res = await fetch(`${BASE}/api/campaigns/${reactivationCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [reactivationSecondProspectId] })
    });
    json = await res.json();
    check('re-adding an already-present prospect adds 0 and never reactivates', json.added === 0 && json.reactivated === false, JSON.stringify(json));

    // --- "Send test email" (POST /api/templates/:id/send-test) - lets someone verify real
    // formatting/merge-tags/unsubscribe-link behavior before actually launching a campaign,
    // without needing a real campaign at all. Should be genuinely functional (real send,
    // real working unsubscribe link) while staying invisible on the real Campaigns list. ---
    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Send-test template', type: 'html', folder: 'General',
        sender_name: 'Tester', subject: 'Hello {{first_name}} from {{company}}', preview_text: '',
        body_html: '<p>Hi {{first_name}}. <a href="{{unsubscribe_link}}">Unsubscribe</a> · {{company_address}}</p>', body_text: '', status: 'active'
      })
    });
    const sendTestTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates/${sendTestTemplateId}/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_email: 'send-test-recipient@example.com', first_name: 'Priya', company: 'Acme', mailbox_id: mailboxId })
    });
    json = await res.json();
    check('sending a test email succeeds and echoes back the recipient', res.status === 200 && json.ok === true && json.to_email === 'send-test-recipient@example.com', JSON.stringify(json));

    res = await fetch(`${BASE}/api/templates/${sendTestTemplateId}/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_email: '', mailbox_id: mailboxId })
    });
    check('sending a test email with no "to" address is rejected with a 400', res.status === 400);

    res = await fetch(`${BASE}/api/templates/${sendTestTemplateId}/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_email: 'x@example.com' })
    });
    check('sending a test email with no mailbox chosen is rejected with a 400', res.status === 400);

    res = await fetch(`${BASE}/api/templates/999999/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_email: 'x@example.com', mailbox_id: mailboxId })
    });
    check('sending a test email for a non-existent template returns a clean 404', res.status === 404);

    const sendTestProspectRow = (await dbIndex.query('SELECT * FROM prospects WHERE email = ?', ['send-test-recipient@example.com']))[0];
    check('the sample recipient exists as a real contact record', !!sendTestProspectRow, JSON.stringify(sendTestProspectRow));

    const sendTestCpRow = (await dbIndex.query('SELECT * FROM campaign_prospects WHERE prospect_id = ?', [sendTestProspectRow.id]))[0];
    check('a real campaign_prospects row anchors the test send', !!sendTestCpRow, JSON.stringify(sendTestCpRow));

    const hiddenTestCampaignRow = (await dbIndex.query('SELECT * FROM campaigns WHERE id = ?', [sendTestCpRow.campaign_id]))[0];
    check('the anchoring campaign is the hidden system test campaign (is_test=1)', hiddenTestCampaignRow && Number(hiddenTestCampaignRow.is_test) === 1, JSON.stringify(hiddenTestCampaignRow));

    res = await fetch(`${BASE}/api/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check('the hidden test campaign never appears in the real Campaigns list over HTTP', !json.some((c) => c.id === hiddenTestCampaignRow.id), JSON.stringify(json.map((c) => c.id)));

    const sendTestSendRow = (await dbIndex.query('SELECT * FROM sends WHERE campaign_prospect_id = ?', [sendTestCpRow.id]))[0];
    check('a real sends row with a tracking token was created for the test email', !!sendTestSendRow && sendTestSendRow.tracking_token.length > 10, JSON.stringify(sendTestSendRow));

    // Sending a second test to the SAME address must reuse the same contact + campaign_prospects
    // row rather than piling up duplicates every time someone re-tests.
    res = await fetch(`${BASE}/api/templates/${sendTestTemplateId}/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_email: 'send-test-recipient@example.com', first_name: 'Rahul', mailbox_id: mailboxId })
    });
    check('sending a second test to the same address succeeds', res.status === 200);
    const sendTestCpRowsAfterSecond = await dbIndex.query('SELECT * FROM campaign_prospects WHERE prospect_id = ?', [sendTestProspectRow.id]);
    check('the second test reuses the same campaign_prospects row instead of creating a duplicate', sendTestCpRowsAfterSecond.length === 1, JSON.stringify(sendTestCpRowsAfterSecond));

    // The test email's tracking links must be genuinely functional, not cosmetic - open/click/
    // unsubscribe should all work exactly like a real send, including real suppression.
    const sendTestToken = sendTestSendRow.tracking_token;
    res = await fetch(`${BASE}/track/open/${sendTestToken}.png`);
    check('the test email\'s open-tracking pixel works for real', res.status === 200);

    res = await fetch(`${BASE}/track/click/${sendTestToken}?u=https://example.com/apply`, { redirect: 'manual' });
    check('the test email\'s click-tracking redirect works for real', res.status === 302 && res.headers.get('location') === 'https://example.com/apply');

    res = await fetch(`${BASE}/unsubscribe/${sendTestToken}`);
    const sendTestUnsubHtml = await res.text();
    check('the test email\'s unsubscribe link genuinely works, not just cosmetically', res.status === 200 && sendTestUnsubHtml.toLowerCase().includes('unsubscribed'));

    const sendTestSuppressionRow = (await dbIndex.query('SELECT * FROM suppression_list WHERE email = ?', ['send-test-recipient@example.com']))[0];
    check(
      'clicking the test email\'s unsubscribe link records the hidden test campaign\'s name, so it\'s clearly identifiable as a test in the Suppression list',
      sendTestSuppressionRow && sendTestSuppressionRow.campaign_name === hiddenTestCampaignRow.name,
      JSON.stringify(sendTestSuppressionRow)
    );

    // Clean up the real suppression this test intentionally created, so it doesn't leak into
    // any later check in this same run that might reuse the same address.
    if (sendTestSuppressionRow) {
      await fetch(`${BASE}/api/settings/suppression/${sendTestSuppressionRow.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    }

    // --- Per-campaign daily send cap (POST /:id/daily-cap) - independent of a mailbox's own
    // cap, so two campaigns sharing one mailbox can each be limited without either one starving
    // the other (e.g. a 1000/day mailbox split as 2/day here vs. an uncapped sibling campaign).
    // Drives real sends via the scheduler up to and past the cap, end-to-end over HTTP, then
    // clears the cap and confirms the previously-blocked prospect sends on the next tick. Uses
    // its own dedicated mailbox with a high cap so it's never accidentally blocked by mailbox-
    // level capacity used up by earlier sections of this same test run. ---
    res = await fetch(`${BASE}/api/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        email: 'daily-cap-mailbox@kabilhirehq.com', display_name: 'Daily Cap Mailbox', smtp_host: 'smtp.gmail.com',
        smtp_port: 587, smtp_user: 'daily-cap-mailbox@kabilhirehq.com', smtp_password: 'x', daily_cap: 1000
      })
    });
    const dailyCapMailboxId = (await res.json()).id;

    res = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Daily-cap test template', type: 'text', folder: 'General',
        sender_name: 'Tester', subject: 'Hi {{first_name}}', preview_text: '',
        body_html: '', body_text: 'Hi {{first_name}}.', status: 'active'
      })
    });
    const dailyCapTemplateId = (await res.json()).id;

    res = await fetch(`${BASE}/api/lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Daily-cap test list' })
    });
    const dailyCapListId = (await res.json()).id;

    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Daily-cap HTTP test campaign', sending_mode: 'pool' })
    });
    const dailyCapCampaignId = (await res.json()).id;

    await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [dailyCapMailboxId] })
    });
    await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: dailyCapTemplateId, wait_days: 0 })
    });

    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/daily-cap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daily_cap: 0 })
    });
    check('setting a daily cap of 0 is rejected (400) - must be a positive number or blank', res.status === 400);

    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/daily-cap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daily_cap: 2 })
    });
    json = await res.json();
    check("POST /:id/daily-cap sets the campaign's daily cap", res.status === 200 && json.daily_cap === 2, JSON.stringify(json));

    const dailyCapAuditRows = (await dbIndex.query(
      "SELECT * FROM audit_log WHERE action = 'campaign_daily_cap_updated'"
    )).filter((r) => String(JSON.parse(r.meta_json || '{}').campaign_id) === String(dailyCapCampaignId));
    check('a campaign_daily_cap_updated audit entry was recorded', dailyCapAuditRows.length === 1, JSON.stringify(dailyCapAuditRows));

    const dailyCapProspectIds = [];
    for (let i = 0; i < 3; i++) {
      res = await fetch(`${BASE}/api/prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: `daily-cap-http-${i}@example.com`, first_name: `DC${i}`, list_id: dailyCapListId })
      });
      dailyCapProspectIds.push((await res.json()).id);
    }
    await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: dailyCapProspectIds })
    });

    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    check('the daily-cap test campaign activates once mailbox+step+prospects are all in place', res.status === 200);

    await scheduler.runOnce({ ignoreWindow: true });
    const dailyCapSendsAfterFirstTick = await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id WHERE cp.campaign_id = ?`,
      [dailyCapCampaignId]
    );
    check(
      "exactly 2 of the 3 prospects send before the campaign's own daily cap of 2 kicks in",
      dailyCapSendsAfterFirstTick.length === 2,
      `sent=${dailyCapSendsAfterFirstTick.length}`
    );

    const dailyCapSkipRows = await dbIndex.query(
      "SELECT * FROM activity_log WHERE campaign_id = ? AND event_type = 'skipped' AND reason = 'campaign_daily_cap_reached'",
      [dailyCapCampaignId]
    );
    check(
      "the 3rd prospect's skip is logged to the activity feed with reason campaign_daily_cap_reached",
      dailyCapSkipRows.length === 1,
      JSON.stringify(dailyCapSkipRows)
    );

    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      "GET /:id reports sent_today matching the cap once it's been reached",
      json.daily_cap === 2 && json.sent_today === 2,
      JSON.stringify({ daily_cap: json.daily_cap, sent_today: json.sent_today })
    );

    // The cap is enforced per campaign, not per mailbox - the same mailbox still has plenty of
    // its own headroom left (cap 1000), so a second, uncapped campaign sharing it must be
    // completely unaffected by the first campaign having already hit its own cap.
    res = await fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Daily-cap sibling (no cap)', sending_mode: 'pool' })
    });
    const dailyCapSiblingCampaignId = (await res.json()).id;
    await fetch(`${BASE}/api/campaigns/${dailyCapSiblingCampaignId}/mailboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mailbox_ids: [dailyCapMailboxId] })
    });
    await fetch(`${BASE}/api/campaigns/${dailyCapSiblingCampaignId}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ step_order: 1, template_id: dailyCapTemplateId, wait_days: 0 })
    });
    res = await fetch(`${BASE}/api/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'daily-cap-sibling@example.com', first_name: 'Sibling', list_id: dailyCapListId })
    });
    const dailyCapSiblingProspectId = (await res.json()).id;
    await fetch(`${BASE}/api/campaigns/${dailyCapSiblingCampaignId}/prospects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prospect_ids: [dailyCapSiblingProspectId] })
    });
    await fetch(`${BASE}/api/campaigns/${dailyCapSiblingCampaignId}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

    await scheduler.runOnce({ ignoreWindow: true });
    const dailyCapSiblingSends = await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id WHERE cp.campaign_id = ?`,
      [dailyCapSiblingCampaignId]
    );
    check(
      "a sibling campaign sharing the same mailbox but with no cap of its own sends normally, unaffected by the first campaign's cap",
      dailyCapSiblingSends.length === 1,
      `sent=${dailyCapSiblingSends.length}`
    );

    // Clearing the cap (blank/null) should let the previously-blocked 3rd prospect through.
    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}/daily-cap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daily_cap: null })
    });
    json = await res.json();
    check('clearing the daily cap (null) succeeds', res.status === 200 && json.daily_cap === null, JSON.stringify(json));

    await scheduler.runOnce({ ignoreWindow: true });
    const dailyCapSendsAfterClear = await dbIndex.query(
      `SELECT s.* FROM sends s INNER JOIN campaign_prospects cp ON cp.id = s.campaign_prospect_id WHERE cp.campaign_id = ?`,
      [dailyCapCampaignId]
    );
    check(
      'once the cap is cleared, the previously-blocked 3rd prospect sends on the next tick',
      dailyCapSendsAfterClear.length === 3,
      `sent=${dailyCapSendsAfterClear.length}`
    );

    res = await fetch(`${BASE}/api/campaigns/${dailyCapCampaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    json = await res.json();
    check(
      "sent_today is null once the campaign has no daily_cap set (not computed for campaigns that don't use the feature)",
      json.daily_cap == null && json.sent_today === null,
      JSON.stringify({ daily_cap: json.daily_cap, sent_today: json.sent_today })
    );

    // Rate limiting is attached to the login route
    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x', password: 'y' })
    });
    check('rate limiter headers present on login route', res.headers.get('ratelimit-limit') !== null || res.headers.get('x-ratelimit-limit') !== null);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} HTTP checks passed.`);
  if (failed.length) {
    failed.forEach((f) => console.log('FAILED: ' + f.name));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('HTTP smoke test crashed:', e);
  process.exitCode = 1;
});

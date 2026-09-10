// Central definition of the "sending guardrail" settings - the values that used to live only
// in backend/.env (DEFAULT_DAILY_CAP, SEND_WINDOW_START_HOUR, etc). They're now stored as rows
// in the `settings` table (same generic key/value table Company & compliance already uses) so
// an admin can tune them from Settings in the UI without editing .env or restarting the server.
//
// Each entry's `default` matches the historical .env default, so a brand-new install behaves
// exactly the same as before until someone changes a value. `key` is the settings-table row key
// (snake_case, same as the .env name lowercased). `label`/`unit`/`description` are shown next to
// the field in Settings so it's clear what each number actually controls.
const SENDING_GUARDRAILS = [
  {
    key: 'default_daily_cap',
    label: 'Default daily cap',
    unit: 'emails / day',
    type: 'number',
    default: 30,
    description: 'Max emails a brand-new mailbox is allowed to send per day once fully warmed up. Only applies at creation time - existing mailboxes keep their own cap, editable under Mailboxes.'
  },
  {
    key: 'warmup_start_cap',
    label: 'Warmup start cap',
    unit: 'emails / day',
    type: 'number',
    default: 5,
    description: 'How many emails a brand-new mailbox may send on day 1 of warmup, before ramping up toward its daily cap.'
  },
  {
    key: 'warmup_ramp_days',
    label: 'Warmup ramp length',
    unit: 'days',
    type: 'number',
    default: 21,
    description: 'How many days it takes a new mailbox to ramp from its warmup start cap up to its full daily cap.'
  },
  {
    key: 'min_hours_between_emails_to_same_prospect',
    label: 'Min gap per prospect',
    unit: 'hours',
    type: 'number',
    default: 72,
    description: 'Minimum hours before the same prospect can receive another email, across every campaign combined - stops one person being flooded.'
  },
  {
    key: 'send_window_start_hour',
    label: 'Send window start',
    unit: '24h hour, e.g. 9 = 9 AM',
    type: 'number',
    default: 9,
    description: 'Hour of day sending is allowed to start. No emails go out before this hour, in your app timezone.'
  },
  {
    key: 'send_window_end_hour',
    label: 'Send window end',
    unit: '24h hour, e.g. 20 = 8 PM',
    type: 'number',
    default: 20,
    description: 'Hour of day sending stops. No emails go out at or after this hour, in your app timezone.'
  },
  {
    key: 'send_only_weekdays',
    label: 'Weekdays only',
    unit: 'on / off',
    type: 'boolean',
    default: true,
    description: 'When on, no emails are ever sent on Saturday or Sunday - only Monday through Friday, inside the send window above.'
  },
  {
    key: 'min_seconds_between_sends',
    label: 'Min delay between sends',
    unit: 'seconds',
    type: 'number',
    default: 45,
    description: 'Shortest randomized pause between one email and the next. A campaign can override this with its own send pace.'
  },
  {
    key: 'max_seconds_between_sends',
    label: 'Max delay between sends',
    unit: 'seconds',
    type: 'number',
    default: 180,
    description: 'Longest randomized pause between sends - the actual gap is picked randomly between min and max each time, so sending doesn’t look like a bot blast.'
  },
  {
    key: 'auto_pause_campaign_bounce_rate_percent',
    label: 'Auto-pause campaign bounce rate',
    unit: '%',
    type: 'number',
    default: 20,
    description: 'A specific campaign is automatically paused (not the whole mailbox) if its own bounce rate - bounces divided by its total recipients - goes at or above this percentage. Protects other campaigns sharing the same mailbox from being punished for one bad list.'
  }
  // Removed by request: auto_pause_bounce_rate_percent, auto_pause_complaint_rate_percent
  // (both mailbox-level) and auto_pause_campaign_complaint_rate_percent (campaign-level spam
  // complaints). The auto-pause checks that read these were disabled in lib/scheduler.js at the
  // same time - only the campaign bounce-rate check above is still active. Any settings-table rows
  // that already exist for the removed keys (on installs seeded before this change) are left alone
  // untouched - they're just no longer read by anything.
];

// [key, value] pairs ready to seed into the settings table (stored as strings, same as every
// other row in that table) - used by each DB driver's init() so these rows exist from first boot.
function defaultSettingsRows() {
  return SENDING_GUARDRAILS.map((s) => [s.key, String(s.default)]);
}

module.exports = { SENDING_GUARDRAILS, defaultSettingsRows };

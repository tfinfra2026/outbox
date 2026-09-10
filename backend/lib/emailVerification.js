// CSV-import email verification pipeline: syntax -> disposable-domain -> domain/MX -> role-based
// heuristic. Deliberately stops short of a real SMTP mailbox probe (RCPT TO) - see the
// conversation this was scoped from: probing individual inboxes at volume from our own sending
// domain risks looking like abuse to receiving mail servers, which is exactly the kind of
// reputation damage we can't afford right after an SES reinstatement. A true "is this specific
// inbox real" check should go through a dedicated third-party verification API instead, if/when
// that's greenlit separately.
const dns = require('dns').promises;
const { isDisposableDomain } = require('./disposableDomains');

// RFC 5322 is far more permissive than this, but this catches the realistic cases (missing @,
// spaces, missing TLD, illegal characters) without the maintenance burden of a "fully compliant"
// regex that would also accept addresses no real mailbox provider actually issues.
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function isValidSyntax(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

// Addresses that technically work but are known to carry a higher bounce/complaint risk for
// cold outreach - shared team inboxes are more likely to be unmonitored, auto-rejected, or
// reported as spam by whoever happens to read them. Flagged as "risky" rather than rejected
// outright, same as a real verification provider would.
const ROLE_BASED_LOCAL_PARTS = new Set([
  'admin', 'administrator', 'info', 'support', 'sales', 'contact', 'noreply', 'no-reply',
  'webmaster', 'postmaster', 'hostmaster', 'hello', 'help', 'billing', 'abuse', 'office',
  'hr', 'careers', 'jobs', 'marketing', 'media', 'press', 'security', 'privacy', 'accounts',
  'enquiries', 'inquiries', 'feedback', 'newsletter', 'team'
]);

function isRoleBasedAddress(email) {
  const localPart = (email.split('@')[0] || '').toLowerCase();
  return ROLE_BASED_LOCAL_PARTS.has(localPart);
}

// Small in-memory cache so a CSV with thousands of rows on a handful of real-world domains
// (gmail.com, outlook.com, the prospect's own company domain repeated across many contacts)
// doesn't trigger a fresh DNS lookup per row - only once per unique domain, then reused for the
// rest of the process's lifetime (capped and time-limited so it can't grow unbounded or go
// permanently stale if a domain's mail setup changes later).
const MX_CACHE = new Map();
const MX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MX_CACHE_MAX_SIZE = 5000;

async function lookupDomainMxStatus(domain) {
  // Automated tests run in a sandboxed environment with no guaranteed outbound DNS/network
  // access, and shouldn't depend on real-world DNS state anyway (flaky, slow, non-deterministic).
  // Mirrors the same TEST_MODE gate lib/mailer.js already uses for its transport - real lookups
  // never run during the smoke test suites, every domain is simply treated as having valid MX.
  if (process.env.TEST_MODE === 'true') return 'has_mx';

  const cached = MX_CACHE.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) return cached.status;

  let status;
  try {
    const mxRecords = await dns.resolveMx(domain);
    status = mxRecords && mxRecords.length > 0 ? 'has_mx' : 'no_records';
    // Some domains (rare, but real) receive mail via a bare A/AAAA record with no MX record at
    // all, per RFC 5321's fallback rule - only worth checking when MX itself came back empty,
    // not as a first choice.
    if (status === 'no_records') {
      try {
        const a = await dns.resolve4(domain).catch(() => []);
        const aaaa = a.length === 0 ? await dns.resolve6(domain).catch(() => []) : [];
        status = (a.length > 0 || aaaa.length > 0) ? 'fallback_only' : 'no_records';
      } catch {
        status = 'no_records';
      }
    }
  } catch (err) {
    // ENOTFOUND/ENODATA = domain genuinely has no mail records - a real, confident "invalid".
    // Anything else (timeout, SERVFAIL, resolver hiccup) is inconclusive, not proof the domain
    // is bad - reported separately as "unknown" rather than incorrectly rejected as invalid.
    status = (err.code === 'ENOTFOUND' || err.code === 'ENODATA') ? 'no_records' : 'lookup_error';
  }

  if (MX_CACHE.size >= MX_CACHE_MAX_SIZE) MX_CACHE.clear(); // simple guard, not a real LRU
  MX_CACHE.set(domain, { status, at: Date.now() });
  return status;
}

// Returns { status, reason } where status is one of:
//   deliverable | risky | invalid | disposable | unknown
// Duplicate detection is intentionally NOT handled here - it's a cross-row concern (needs to see
// every row in the batch/file at once), not a per-email property, so callers handle it themselves
// before or after calling this.
async function verifyEmail(email) {
  const trimmed = (email || '').toLowerCase().trim();

  if (!isValidSyntax(trimmed)) {
    return { status: 'invalid', reason: 'Malformed email address' };
  }

  const domain = trimmed.split('@')[1];

  if (isDisposableDomain(domain)) {
    return { status: 'disposable', reason: 'Known disposable/temporary email domain' };
  }

  const mxStatus = await lookupDomainMxStatus(domain);
  if (mxStatus === 'no_records') {
    return { status: 'invalid', reason: 'Domain has no mail server (MX) records' };
  }
  if (mxStatus === 'lookup_error') {
    return { status: 'unknown', reason: 'Could not confirm the domain\'s mail records right now' };
  }
  if (mxStatus === 'fallback_only') {
    return { status: 'risky', reason: 'Domain accepts mail only via a fallback A/AAAA record, no MX' };
  }

  // Role-based/shared inboxes (hr@, recruitment@, jobs@, careers@, sales@, etc.) used to be
  // flagged as risky and rejected outright, on the general cold-outreach assumption that shared
  // inboxes are more likely unmonitored or auto-rejected. That assumption doesn't hold for this
  // app's actual use case - recruitment/staffing outreach is often deliberately targeting exactly
  // these addresses (hr@, recruitment@, jobs@ ARE the intended recipient, not a fallback). Per
  // explicit decision, these are no longer downgraded - isRoleBasedAddress is kept/exported for
  // any future per-contact labeling, but no longer affects the deliverable/risky verdict here.

  return { status: 'deliverable', reason: null };
}

module.exports = { isValidSyntax, isRoleBasedAddress, lookupDomainMxStatus, verifyEmail, ROLE_BASED_LOCAL_PARTS };

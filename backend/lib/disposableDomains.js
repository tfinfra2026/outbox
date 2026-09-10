// A static list of known disposable/temporary-email domains, checked during CSV import
// verification (see lib/emailVerification.js). Not exhaustive - new disposable services pop up
// constantly - but covers the large majority of common ones seen in cold-outreach lists.
// Bundled as a plain JS Set rather than fetched live, so verification stays fast and works
// without any outbound network call beyond the per-domain MX lookup that already happens.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator.org', 'guerrillamail.com', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamail.biz', 'guerrillamailblock.com', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', '10minutemail.co.za', '20minutemail.com',
  'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'tempmail.de', 'tempinbox.com',
  'throwawaymail.com', 'throwam.com', 'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf',
  'jetable.fr.nf', 'nomail.xl.cx', 'trashmail.com', 'trashmail.net', 'trashmail.me',
  'trash-mail.com', 'trashmailer.com', 'trashinbox.com', 'dispostable.com', 'getnada.com',
  'nada.email', 'fakeinbox.com', 'fakemailgenerator.com', 'maildrop.cc', 'mintemail.com',
  'moakt.com', 'moakt.cc', 'mohmal.com', 'mohmal.im', 'mohmal.in', 'emailondeck.com',
  'spamgourmet.com', 'spam4.me', 'mytemp.email', 'mailnesia.com', 'mailcatch.com',
  'inboxbear.com', 'mailsac.com', 'mail-temp.com', 'tempail.com', 'tempm.com', 'tempmailapp.com',
  'burnermail.io', 'harakirimail.com', 'incognitomail.com', 'anonbox.net', 'discard.email',
  'discardmail.com', 'dontsendmespam.de', 'e4ward.com', 'einrot.com', 'fakemail.net',
  'getairmail.com', 'guerillamail.info', 'meltmail.com', 'mytrashmail.com', 'no-spam.ws',
  'noclickemail.com', 'objectmail.com', 'oneoffemail.com', 'pookmail.com', 'quickinbox.com',
  'rcpt.at', 'safe-mail.net', 'sneakemail.com', 'sogetthis.com', 'spambox.us', 'spamfree24.org',
  'spamherelots.com', 'spamhole.com', 'spamify.com', 'suremail.info', 'tempemail.co',
  'temporaryemail.net', 'temporarymail.com', 'temporaryinbox.com', 'tmail.ws', 'tmailinator.com',
  'tyldd.com', 'veryrealemail.com', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org',
  'zoemail.org', 'mail-filter.com', 'mailtemp.info', 'crazymailing.com', 'emailfake.com',
  'emailsensei.com', 'fakemailz.com', 'lroid.com', 'luxusmail.org', 'mailbox52.ml',
  '33mail.com', 'armyspy.com', 'cuvox.de', 'dayrep.com', 'einrot.de', 'fleckens.hu',
  'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us', 'trbvm.com'
]);

function isDisposableDomain(domain) {
  return DISPOSABLE_DOMAINS.has((domain || '').toLowerCase().trim());
}

module.exports = { DISPOSABLE_DOMAINS, isDisposableDomain };

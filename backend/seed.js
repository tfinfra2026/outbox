// Optional demo data - run with `npm run seed` after configuring .env, purely so your team
// can click around the dashboard with something in it before connecting real mailboxes.
// Safe to skip entirely in production.
require('dotenv').config();
const db = require('./db/index');
const { Users, Domains, Mailboxes, Templates, Prospects, Campaigns } = require('./db/repo');
const { hashPassword } = require('./lib/auth');
const { encrypt } = require('./lib/crypto');

async function main() {
  await db.init();

  const existingAdmin = await Users.findByEmail('admin@techforceglobal.com');
  let adminId;
  if (!existingAdmin) {
    const r = await Users.create('admin@techforceglobal.com', hashPassword('ChangeMe123!'), 'Bhavin Shah', 'admin');
    adminId = r.insertId;
    console.log('Created demo admin login -> admin@techforceglobal.com / ChangeMe123! (change this immediately)');
  } else {
    adminId = existingAdmin.id;
    console.log('Admin user already exists, skipping.');
  }

  const domain = await Domains.create('kabilhirehq.com', 'click.kabilhirehq.com');
  const mailbox = await Mailboxes.create({
    domain_id: domain.insertId,
    email: 'raj@kabilhirehq.com',
    display_name: 'KabilHire Talent Team',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_user: 'raj@kabilhirehq.com',
    smtp_pass_encrypted: encrypt('replace-with-a-real-app-password'),
    daily_cap: 50
  });

  const initialTemplate = await Templates.create({
    name: 'Initial outreach - SaaS founders',
    type: 'html',
    folder: 'Cold outreach',
    sender_name: 'KabilHire Talent Team',
    subject: 'Quick question, {{first_name}}',
    preview_text: 'A faster way to get hired',
    body_html: '<p>Hi {{first_name}},</p><p>KabilHire is a reverse-matching engine for Indian tech professionals - your profile goes to verified recruiters instead of you chasing job boards.</p><p>Worth a 3 minute look?</p>',
    body_text: '',
    status: 'active'
  });

  const followupTemplate = await Templates.create({
    name: 'Follow-up 1 - gentle nudge',
    type: 'text',
    folder: 'Follow-ups',
    sender_name: 'KabilHire Talent Team',
    subject: 'Following up, {{first_name}}',
    preview_text: '',
    body_html: '',
    body_text: 'Hi {{first_name}}, just floating this back up in case it got buried. Happy to share more detail whenever useful.',
    status: 'active'
  });

  const campaign = await Campaigns.create('Kabilhire - SaaS founders', 'pool', adminId);
  await Campaigns.assignMailbox(campaign.insertId, mailbox.insertId);
  await Campaigns.addStep(campaign.insertId, 1, initialTemplate.insertId, 0, false);
  await Campaigns.addStep(campaign.insertId, 2, followupTemplate.insertId, 3, true);

  const p1 = await Prospects.upsert({ email: 'founder1@example.com', first_name: 'Aditi', company: 'Example Inc' });
  const p2 = await Prospects.upsert({ email: 'founder2@example.com', first_name: 'Rahul', company: 'Beta Labs' });
  await Campaigns.addProspects(campaign.insertId, [p1.id, p2.id]);

  console.log('Seed data created: 1 domain, 1 mailbox (placeholder credentials), 2 templates, 1 draft campaign with 2 prospects.');
  console.log('Remember: the mailbox has a fake SMTP password - update it from Settings > Mailboxes before activating the campaign for real.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Seeding failed:', e);
  process.exit(1);
});

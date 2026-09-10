require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

const db = require('./db/index');
const scheduler = require('./lib/scheduler');
const bounceCapture = require('./lib/bounceCapture');

const app = express();

// Apache/Cloudflare are reverse proxies in front of Express.
// Trust the first proxy so express-rate-limit can safely use X-Forwarded-For.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Rate limit login/setup to slow down brute-forcing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/setup', authLimiter);

// Public tracking endpoints (opens, clicks, unsubscribe, bounce webhook) - no auth.
app.use('/track', require('./routes/track'));

app.use('/unsubscribe', (req, res, next) => {
  req.url = '/unsubscribe' + req.url;
  next();
}, require('./routes/track'));

// Authenticated API.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/domains', require('./routes/domains'));
app.use('/api/mailboxes', require('./routes/mailboxes'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/prospects', require('./routes/prospects'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: db.driverName
  });
});

// Serve the built React frontend in production.
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');

app.use(express.static(frontendDist));

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/track') ||
    req.path.startsWith('/unsubscribe')
  ) {
    return next();
  }

  res.sendFile(
    path.join(frontendDist, 'index.html'),
    (err) => {
      if (err) {
        res.status(200).send(
          'Techforce Outbox API is running. Build the frontend with: cd frontend && npm run build'
        );
      }
    }
  );
});

// Global error handler.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err);

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong on our end. Check the server logs for details.'
        : err.message
  });
});

async function start() {
  await db.init();

  const port = process.env.PORT || 4000;

  app.listen(port, () => {
    console.log(
      `[server] Techforce Outbox listening on port ${port} (db: ${db.driverName})`
    );
  });

  cron.schedule('* * * * *', async () => {
    try {
      const result = await scheduler.runOnce();

      if (!result.skipped) {
        console.log(
          `[scheduler] processed ${result.processed}, sent ${result.sent}, skipped ${result.skipped}`
        );
      }
    } catch (e) {
      console.error('[scheduler] error', e);
    }
  });

  // Was every 5 minutes - tightened to every 1 minute by request, so a Plain-SMTP/IMAP mailbox's
  // bounce capture feels closer to AWS SES's instant webhook. Tradeoff accepted: this logs into
  // each IMAP-configured mailbox's inbox once a minute instead of once every 5 - if a provider
  // ever flags that as suspicious/excessive login activity, widen this back out.
  cron.schedule('* * * * *', async () => {
    try {
      const results = await bounceCapture.pollAllImapMailboxes();

      const totalBounced = results.reduce(
        (sum, r) => sum + r.bounced,
        0
      );

      if (results.length > 0) {
        console.log(
          `[bounce capture] polled ${results.length} IMAP mailbox(es), found ${totalBounced} bounce(s)`
        );
      }
    } catch (e) {
      console.error('[bounce capture] error', e);
    }
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };

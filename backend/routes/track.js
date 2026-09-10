// Public routes - deliberately NOT behind requireAuth, since these links are clicked by
// prospects in their inbox, not by logged-in team members.

const express = require('express');
const router = express.Router();

const {
  Sends,
  Suppression,
  CampaignProspects,
  Campaigns,
  Mailboxes,
  ActivityLog
} = require('../db/repo');

const asyncHandler = require('../lib/asyncHandler');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);


// =========================================================
// OPEN TRACKING
// =========================================================

router.get('/open/:token.png', asyncHandler(async (req, res) => {
  try {
    const send = await Sends.findByToken(req.params.token);

    if (send && !send.opened_at) {
      await ActivityLog.recordEngagement(send, 'opened');
    }

    await Sends.markOpened(req.params.token);
  } catch (e) {
    // Invalid/expired token - still return the pixel.
  }

  res.set('Content-Type', 'image/png');
  res.send(TRANSPARENT_PNG);
}));


// =========================================================
// CLICK TRACKING
// =========================================================

router.get('/click/:token', asyncHandler(async (req, res) => {
  const destination = req.query.u || '/';

  try {
    const send = await Sends.findByToken(req.params.token);

    if (send && !send.clicked_at) {
      await ActivityLog.recordEngagement(send, 'clicked');
    }

    await Sends.markClicked(req.params.token);
  } catch (e) {
    // Ignore invalid/expired tokens.
  }

  res.redirect(destination);
}));


// =========================================================
// UNSUBSCRIBE
// =========================================================

router.get('/unsubscribe/:token', asyncHandler(async (req, res) => {
  const send = await Sends.findByToken(req.params.token);

  if (!send) {
    return res
      .status(404)
      .send('This unsubscribe link is invalid or has expired.');
  }

  const cp = await CampaignProspects.get(send.campaign_prospect_id);

  const db = require('../db/index');

  const prospectRow = (
    await db.query(
      'SELECT email FROM prospects WHERE id = ?',
      [cp.prospect_id]
    )
  )[0];

  const unsubCampaign = await Campaigns.get(cp.campaign_id);

  await Suppression.add(
    prospectRow.email,
    'unsubscribed',
    unsubCampaign ? unsubCampaign.name : null
  );

  await CampaignProspects.markStopped(
    cp.id,
    'unsubscribed'
  );

  res.set('Content-Type', 'text/html');

  res.send(`<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333;">
  <h2>You're unsubscribed</h2>
  <p>
    ${prospectRow.email} will not receive any further emails from us.
    This can take a few minutes to apply everywhere.
  </p>
</body>
</html>`);
}));


// =========================================================
// INTERNAL / SIMPLE BOUNCE WEBHOOK
// =========================================================
//
// Expected:
//
// {
//   "token": "...",
//   "type": "bounce" | "complaint" | "hard" | "soft"
// }
//
// Used by internal smoke tests / non-SES providers.

router.post(
  '/webhook/bounce',
  express.json(),
  asyncHandler(async (req, res) => {

    const { token, type } = req.body;

    if (!token || !type) {
      return res.status(400).json({
        error: 'token and type are required'
      });
    }

    const send = await Sends.findByToken(token);

    if (!send) {
      return res.status(404).json({
        error: 'Unknown tracking token'
      });
    }

    await Sends.markBounced(token, type);

    await ActivityLog.recordEngagement(
      send,
      'bounced',
      type
    );

    if (type === 'complaint') {
      await Mailboxes.incrementComplaint(send.mailbox_id);
    } else {
      await Mailboxes.incrementBounce(send.mailbox_id);
    }

    const cp = await CampaignProspects.get(
      send.campaign_prospect_id
    );

    const db = require('../db/index');

    const prospectRow = (
      await db.query(
        'SELECT email FROM prospects WHERE id = ?',
        [cp.prospect_id]
      )
    )[0];

    if (type === 'hard' || type === 'complaint') {

      const bounceCampaign = await Campaigns.get(
        cp.campaign_id
      );

      await Suppression.add(
        prospectRow.email,
        type === 'complaint'
          ? 'complaint'
          : 'bounced',
        bounceCampaign
          ? bounceCampaign.name
          : null
      );
    }

    res.json({
      ok: true
    });
  })
);


// =========================================================
// AMAZON SES → SNS WEBHOOK
// =========================================================
//
// Public endpoint:
//
// POST /track/webhook/ses
//
// SNS sends:
//
// SubscriptionConfirmation
// Notification
// UnsubscribeConfirmation
//
// SES notification can contain:
//
// Bounce
// Complaint
// Delivery
// DeliveryDelay
//
// This endpoint intentionally ACKs SNS with HTTP 200 so SNS does not
// continuously retry malformed/non-actionable messages.
//
// IMPORTANT:
// For production, SNS SignatureVersion verification should be added
// before trusting SubscriptionConfirmation/Notification messages.
// =========================================================

router.post(
  '/webhook/ses',
  express.json({
    type: ['application/json', 'text/plain']
  }),
  asyncHandler(async (req, res) => {

    // -----------------------------------------------------
    // LOG EVERY SES/SNS REQUEST
    // -----------------------------------------------------

    console.log(
      `[ses webhook] POST received ` +
      `content-type=${req.headers['content-type'] || 'unknown'}`
    );

    const body = req.body || {};

    console.log(
      `[ses webhook] SNS type=${body.Type || 'unknown'} ` +
      `messageId=${body.MessageId || 'unknown'}`
    );


    // -----------------------------------------------------
    // BASIC BODY CHECK
    // -----------------------------------------------------

    if (!body || typeof body !== 'object') {

      console.warn(
        '[ses webhook] invalid/empty request body'
      );

      return res.status(200).json({
        ok: true
      });
    }


    // -----------------------------------------------------
    // SNS SUBSCRIPTION CONFIRMATION
    // -----------------------------------------------------

    if (
      body.Type === 'SubscriptionConfirmation' ||
      body.Type === 'UnsubscribeConfirmation'
    ) {

      console.log(
        `[ses webhook] ${body.Type} received ` +
        `topic=${body.TopicArn || 'unknown'}`
      );

      if (body.SubscribeURL) {

        try {

          await fetch(body.SubscribeURL);

          console.log(
            `[ses webhook] confirmed SNS ${body.Type} ` +
            `for topic ${body.TopicArn || 'unknown'}`
          );

        } catch (err) {

          console.error(
            '[ses webhook] failed to auto-confirm SNS subscription:',
            err.message
          );
        }

      } else {

        console.warn(
          `[ses webhook] ${body.Type} received without SubscribeURL`
        );
      }

      return res.status(200).json({
        ok: true
      });
    }


    // -----------------------------------------------------
    // ONLY PROCESS SNS NOTIFICATIONS
    // -----------------------------------------------------

    if (body.Type !== 'Notification') {

      console.log(
        `[ses webhook] ignoring SNS type=${body.Type || 'unknown'}`
      );

      return res.status(200).json({
        ok: true
      });
    }


    // -----------------------------------------------------
    // PARSE SNS MESSAGE
    // -----------------------------------------------------

    let message;

    try {

      if (typeof body.Message === 'string') {
        message = JSON.parse(body.Message);
      } else {
        message = body.Message || {};
      }

    } catch (err) {

      console.error(
        '[ses webhook] could not parse SNS Message:',
        err.message
      );

      return res.status(200).json({
        ok: true
      });
    }


    // -----------------------------------------------------
    // SUPPORT BOTH SES FORMATS
    // -----------------------------------------------------
    //
    // Legacy:
    //
    // notificationType = Bounce
    // notificationType = Complaint
    // notificationType = Delivery
    //
    // Event publishing:
    //
    // eventType = Bounce
    // eventType = Complaint
    // eventType = Delivery
    // eventType = DeliveryDelay
    // -----------------------------------------------------

    const notificationType =
      message.notificationType ||
      message.eventType ||
      'Unknown';


    // -----------------------------------------------------
    // EXTRACT SES MESSAGE ID
    // -----------------------------------------------------

    const sesMessageId =
      message.mail &&
      message.mail.messageId
        ? message.mail.messageId
        : null;


    console.log(
      `[ses webhook] SES event=${notificationType} ` +
      `messageId=${sesMessageId || 'unknown'}`
    );


    // -----------------------------------------------------
    // DELIVERY
    // -----------------------------------------------------

    if (notificationType === 'Delivery') {

      const recipients =
        message.delivery &&
        Array.isArray(message.delivery.recipients)
          ? message.delivery.recipients
          : [];

      console.log(
        `[ses webhook] DELIVERY ` +
        `messageId=${sesMessageId || 'unknown'} ` +
        `recipients=${recipients.length}`
      );

      for (const email of recipients) {

        console.log(
          `[ses webhook] delivery recipient=${email}`
        );
      }

      // ---------------------------------------------------
      // IMPORTANT:
      // Do not call a non-existing Sends.markDelivered()
      // method here. Your current repo was not provided with
      // such a method.
      //
      // Delivery is therefore logged safely for now.
      // ---------------------------------------------------

      return res.status(200).json({
        ok: true,
        event: 'Delivery',
        messageId: sesMessageId,
        recipients: recipients.length
      });
    }


    // -----------------------------------------------------
    // DELIVERY DELAY
    // -----------------------------------------------------

    if (notificationType === 'DeliveryDelay') {

      const delay =
        message.deliveryDelay || {};

      const recipients =
        Array.isArray(delay.recipients)
          ? delay.recipients
          : [];

      console.warn(
        `[ses webhook] DELIVERY DELAY ` +
        `messageId=${sesMessageId || 'unknown'} ` +
        `recipients=${recipients.length} ` +
        `type=${delay.delayType || 'unknown'}`
      );

      for (const email of recipients) {

        console.warn(
          `[ses webhook] delivery delay recipient=${email}`
        );
      }

      return res.status(200).json({
        ok: true,
        event: 'DeliveryDelay',
        messageId: sesMessageId,
        recipients: recipients.length
      });
    }


    // -----------------------------------------------------
    // BOUNCE / COMPLAINT
    // -----------------------------------------------------

    if (
      notificationType !== 'Bounce' &&
      notificationType !== 'Complaint'
    ) {

      console.log(
        `[ses webhook] ignoring unsupported SES event=${notificationType}`
      );

      return res.status(200).json({
        ok: true
      });
    }


    // -----------------------------------------------------
    // EXTRACT RECIPIENTS
    // -----------------------------------------------------

    let recipients = [];

    if (notificationType === 'Bounce') {

      recipients =
        message.bounce &&
        Array.isArray(message.bounce.bouncedRecipients)
          ? message.bounce.bouncedRecipients.map(
              (r) => r.emailAddress
            )
          : [];

    } else {

      recipients =
        message.complaint &&
        Array.isArray(message.complaint.complainedRecipients)
          ? message.complaint.complainedRecipients.map(
              (r) => r.emailAddress
            )
          : [];
    }


    // -----------------------------------------------------
    // DETERMINE INTERNAL TYPE
    // -----------------------------------------------------

    let type;

    if (notificationType === 'Complaint') {

      type = 'complaint';

    } else {

      type =
        message.bounce &&
        message.bounce.bounceType === 'Permanent'
          ? 'hard'
          : 'soft';
    }


    console.log(
      `[ses webhook] ${notificationType} ` +
      `type=${type} ` +
      `messageId=${sesMessageId || 'unknown'} ` +
      `recipients=${recipients.length}`
    );


    // -----------------------------------------------------
    // PROCESS RECIPIENTS
    // -----------------------------------------------------

    let processed = 0;

    for (const rawEmail of recipients) {

      const email =
        (rawEmail || '')
          .toLowerCase()
          .trim();

      if (!email) {
        continue;
      }


      console.log(
        `[ses webhook] processing ${notificationType} for ${email}`
      );


      // ---------------------------------------------------
      // CURRENT MATCHING METHOD
      // ---------------------------------------------------
      //
      // Uses the existing repository method.
      //
      // Later we should improve this to use:
      //
      // message.mail.messageId
      //
      // rather than email address alone.
      // ---------------------------------------------------

      const send =
        await Sends.findMostRecentUnbouncedByEmail(email);


      if (!send) {

        console.warn(
          `[ses webhook] received ${notificationType} ` +
          `for ${email} but found no matching send record`
        );

        continue;
      }


      // ---------------------------------------------------
      // MARK BOUNCED
      // ---------------------------------------------------

      await Sends.markBounced(
        send.tracking_token,
        type
      );


      // ---------------------------------------------------
      // ACTIVITY LOG
      // ---------------------------------------------------

      await ActivityLog.recordEngagement(
        send,
        'bounced',
        type
      );


      // ---------------------------------------------------
      // MAILBOX COUNTERS
      // ---------------------------------------------------

      if (type === 'complaint') {

        await Mailboxes.incrementComplaint(
          send.mailbox_id
        );

      } else {

        await Mailboxes.incrementBounce(
          send.mailbox_id
        );
      }


      // ---------------------------------------------------
      // SUPPRESSION
      // ---------------------------------------------------

      if (
        type === 'hard' ||
        type === 'complaint'
      ) {

        const cp =
          await CampaignProspects.get(
            send.campaign_prospect_id
          );

        const bounceCampaign =
          cp
            ? await Campaigns.get(cp.campaign_id)
            : null;

        await Suppression.add(
          email,
          type === 'complaint'
            ? 'complaint'
            : 'bounced',
          bounceCampaign
            ? bounceCampaign.name
            : null
        );

        console.log(
          `[ses webhook] suppressed ${email} ` +
          `reason=${type === 'complaint' ? 'complaint' : 'bounced'}`
        );
      }


      processed += 1;

      console.log(
        `[ses webhook] processed ${notificationType} ` +
        `for ${email}`
      );
    }


    // -----------------------------------------------------
    // FINAL RESPONSE
    // -----------------------------------------------------

    console.log(
      `[ses webhook] completed event=${notificationType} ` +
      `processed=${processed} ` +
      `messageId=${sesMessageId || 'unknown'}`
    );


    return res.status(200).json({
      ok: true,
      processed,
      event: notificationType,
      messageId: sesMessageId
    });
  })
);


// =========================================================
// EXPORT
// =========================================================

module.exports = router;

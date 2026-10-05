const nodemailer = require("nodemailer");
let running = false;
async function queueMail(db, key, to, subject, text) {
  if (!to) return;
  await db.collection("email_outbox").updateOne(
    { key },
    {
      $setOnInsert: {
        key,
        to,
        subject,
        text,
        status: "pending",
        attempts: 0,
        nextAttempt: new Date(),
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}
function startMailWorker(db) {
  const transporter = nodemailer.createTransport(
    process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === "true",
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        }
      : {
          service: "gmail",
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        },
  );
  const tick = async () => {
    if (running || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
    running = true;
    try {
      for (let i = 0; i < 10; i++) {
        const mail = await db.collection("email_outbox").findOneAndUpdate(
          {
            $or: [
              { status: "pending", nextAttempt: { $lte: new Date() } },
              { status: "sending", leaseUntil: { $lt: new Date() } },
            ],
          },
          {
            $set: {
              status: "sending",
              leaseUntil: new Date(Date.now() + 120000),
            },
            $inc: { attempts: 1 },
          },
          { returnDocument: "after", sort: { createdAt: 1 } },
        );
        if (!mail) break;
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
          });
          await db
            .collection("email_outbox")
            .updateOne(
              { _id: mail._id },
              { $set: { status: "sent", sentAt: new Date() } },
            );
        } catch (error) {
          await db.collection("email_outbox").updateOne(
            { _id: mail._id },
            {
              $set: {
                status: "pending",
                nextAttempt: new Date(
                  Date.now() +
                    Math.min(3600000, 30000 * 2 ** Math.min(mail.attempts, 7)),
                ),
                lastError: error.code || "SEND_FAILED",
              },
            },
          );
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    () =>
      tick().catch((error) =>
        console.error("[mail] queue unavailable", error.name),
      ),
    15000,
  );
  timer.unref();
  tick().catch(() => {});
  return timer;
}
module.exports = { queueMail, startMailWorker };

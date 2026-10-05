const Stripe = require("stripe");
const { randomBytes } = require("node:crypto");
const { catalog } = require("../config/plans");
const { acquire } = require("./usage");
const { apiError } = require("./gemini");
let client;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY)
    throw apiError(503, "Stripe is not configured.");
  return (client ||= new Stripe(process.env.STRIPE_SECRET_KEY));
}
const objectId = (value) => (typeof value === "string" ? value : value?.id);
function priceId(plan, cycle) {
  return process.env[
    `STRIPE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`
  ];
}
function pricePlan(id) {
  for (const p of catalog().filter((p) => p.id !== "basic"))
    for (const cycle of ["monthly", "yearly"])
      if (priceId(p.id, cycle) === id) return { plan: p.id, cycle };
  return null;
}
async function reconcile(db, subscription, heldLock) {
  const customerId = objectId(subscription.customer);
  const user = await db
    .collection("users")
    .findOne({ stripeCustomerId: customerId });
  if (!user)
    throw apiError(
      503,
      "Billing customer has not been linked yet. Retry webhook.",
    );
  const mapped = pricePlan(objectId(subscription.items.data[0]?.price));
  if (!mapped)
    throw apiError(
      503,
      "Unknown Stripe price. Configure the matching price ID.",
    );
  const item = subscription.items.data[0];
  const expiry = new Date(
    (item.current_period_end || subscription.current_period_end || 0) * 1000,
  );
  const lock = heldLock || (await acquire(db, user.uid));
  try {
    const invoices = await db
      .collection("payments")
      .find({ subscriptionId: subscription.id, status: "completed" })
      .sort({ completedAt: -1 })
      .toArray();
    const grant = invoices.find(
      (p) => p.amountMinor === 0 || (p.refundedMinor || 0) < p.amountMinor,
    );
    const rank = { basic: 0, standard: 1, premium: 2 };
    const paidPlan = grant
      ? rank[grant.plan] < rank[mapped.plan]
        ? grant.plan
        : mapped.plan
      : "basic";
    const paidExpiry = grant
      ? new Date(Math.min(+expiry, +new Date(grant.accessThrough || expiry)))
      : new Date(0);
    await db.collection("users").updateOne(
      { uid: user.uid },
      {
        $set: {
          package: paidPlan,
          packageExpiry: paidExpiry,
          subscriptionStatus: subscription.status,
          stripeSubscriptionId: subscription.id,
          billingCycle: mapped.cycle,
          cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
          updatedAt: new Date(),
        },
      },
    );
  } finally {
    if (!heldLock) await lock.release();
  }
}
async function syncCustomer(db, customerId) {
  const user = await db
    .collection("users")
    .findOne({ stripeCustomerId: customerId });
  if (!user) throw apiError(503, "Billing customer mapping pending.");
  const lock = await acquire(db, user.uid);
  try {
    // Read current Stripe state while holding the user lock, so concurrent events cannot revert it.
    const subscriptions = await stripe().subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    const known = subscriptions.data.filter((s) =>
      pricePlan(objectId(s.items.data[0]?.price)),
    );
    const chosen =
      known
        .filter((s) => ["active", "trialing", "past_due"].includes(s.status))
        .sort((a, b) => b.created - a.created)[0] ||
      known.sort((a, b) => b.created - a.created)[0];
    if (chosen) await reconcile(db, chosen, lock);
  } finally {
    await lock.release();
  }
}

async function handleEvent(db, event) {
  const seen = await db
    .collection("stripe_events")
    .findOne({ eventId: event.id, status: "done" });
  if (seen) return;
  const obj = event.data.object;
  if (event.type.startsWith("customer.subscription."))
    await syncCustomer(db, objectId(obj.customer));
  if (
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type)
  ) {
    if (
      obj.payment_status === "paid" ||
      obj.payment_status === "no_payment_required"
    )
      await syncCustomer(db, objectId(obj.customer));
  }
  if (event.type === "invoice.paid") {
    const invoice = await stripe().invoices.retrieve(obj.id);
    const customerId = objectId(invoice.customer);
    const user = await db
      .collection("users")
      .findOne({ stripeCustomerId: customerId });
    if (!user) throw apiError(503, "Customer mapping pending.");
    const subscriptionId = objectId(
      invoice.parent?.subscription_details?.subscription ||
        invoice.subscription,
    );
    if (subscriptionId) {
      const sub = await stripe().subscriptions.retrieve(subscriptionId);
      const billedLine = invoice.lines?.data?.find((line) =>
        pricePlan(objectId(line.pricing?.price_details?.price || line.price)),
      );
      const mapped = pricePlan(
        objectId(
          billedLine?.pricing?.price_details?.price ||
            billedLine?.price ||
            sub.items.data[0]?.price,
        ),
      );
      if (!mapped) throw apiError(503, "Unknown subscription price.");
      if (invoice.currency !== "bdt")
        throw apiError(
          503,
          "Unexpected invoice currency. This catalog uses BDT.",
        );
      await db.collection("payments").updateOne(
        { stripeInvoiceId: invoice.id },
        {
          $setOnInsert: {
            stripeInvoiceId: invoice.id,
            userId: user.uid,
            userEmail: user.email,
            customerId,
            subscriptionId,
            plan: mapped.plan,
            billingCycle: mapped.cycle,
            currency: "bdt",
            accessThrough: new Date(
              (billedLine?.period?.end ||
                sub.items.data[0]?.current_period_end ||
                sub.current_period_end ||
                0) * 1000,
            ),
            amountMinor: invoice.amount_paid,
            refundedMinor: 0,
            status: "completed",
            hostedInvoiceUrl: invoice.hosted_invoice_url,
            invoicePdf: invoice.invoice_pdf,
            completedAt: new Date(
              (invoice.status_transitions?.paid_at || event.created) * 1000,
            ),
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      await syncCustomer(db, customerId);
    }
  }
  if (event.type === "invoice.payment_failed") {
    await syncCustomer(db, objectId(obj.customer));
    const user = await db
      .collection("users")
      .findOne({ stripeCustomerId: objectId(obj.customer) });
    if (user)
      await require("./mailQueue").queueMail(
        db,
        `billing-failed:${obj.id}:${obj.attempt_count}`,
        user.email,
        "Career Connect AI — subscription payment failed",
        "Your subscription payment failed. Open Pricing → Manage billing to update your payment method. Paid tools require an active, paid subscription.",
      );
  }
  if (event.type === "charge.refunded") {
    const charge = await stripe().charges.retrieve(obj.id);
    const directInvoice = objectId(charge.invoice);
    let invoiceIds = directInvoice ? [directInvoice] : [];
    if (!directInvoice && objectId(charge.payment_intent)) {
      const records = await stripe().invoicePayments.list({
        payment: {
          type: "payment_intent",
          payment_intent: objectId(charge.payment_intent),
        },
        limit: 100,
      });
      invoiceIds = [...new Set(records.data.map((p) => objectId(p.invoice)))];
    }
    for (const invoiceId of invoiceIds) {
      const payment = await db
        .collection("payments")
        .findOne({ stripeInvoiceId: invoiceId });
      if (!payment)
        throw apiError(
          503,
          "Invoice payment not recorded yet; retry refund event.",
        );
      await db
        .collection("payment_refunds")
        .updateOne(
          { chargeId: charge.id },
          {
            $set: {
              stripeInvoiceId: invoiceId,
              amountMinor: charge.amount_refunded,
              currency: charge.currency,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      const refunds = await db
        .collection("payment_refunds")
        .find({ stripeInvoiceId: invoiceId })
        .toArray();
      const total = refunds.reduce((sum, r) => sum + r.amountMinor, 0);
      await db
        .collection("payments")
        .updateOne(
          { stripeInvoiceId: invoiceId },
          {
            $set: {
              refundedMinor: Math.min(payment.amountMinor, total),
              updatedAt: new Date(),
            },
          },
        );
      await syncCustomer(db, payment.customerId);
    }
  }

  await db
    .collection("stripe_events")
    .updateOne(
      { eventId: event.id },
      { $set: { status: "done", type: event.type, processedAt: new Date() } },
      { upsert: true },
    );
}
function webhook(getDb) {
  return async (req, res) => {
    let event;
    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET)
        throw new Error("Webhook not configured");
      event = stripe().webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid Stripe webhook signature." });
    }
    const db = getDb();
    if (!db)
      return res.status(503).json({ error: "Database is starting. Retry." });
    try {
      await handleEvent(db, event);
      res.json({ received: true });
    } catch (e) {
      console.error("[billing] webhook failed", event.type, e.name);
      res
        .status(503)
        .json({ error: "Webhook processing failed. Stripe will retry." });
    }
  };
}
async function checkout(db, user, plan, cycle) {
  if (
    !["standard", "premium"].includes(plan) ||
    !["monthly", "yearly"].includes(cycle)
  )
    throw apiError(400, "Select a valid paid plan and billing cycle.");
  const id = priceId(plan, cycle);
  if (!id)
    throw apiError(
      503,
      "Stripe price is not configured. Run the catalog setup script.",
    );
  const expected = catalog().find((p) => p.id === plan)[cycle];
  const price = await stripe().prices.retrieve(id);
  if (
    price.currency !== "bdt" ||
    price.unit_amount !== expected ||
    price.recurring?.interval !== (cycle === "monthly" ? "month" : "year")
  )
    throw apiError(
      503,
      "Stripe Price and application catalog differ. Check configuration.",
    );
  const lock = await acquire(db, user.uid);
  try {
    let customerId = lock.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe().customers.create(
        { email: user.email, name: user.displayName || undefined },
        { idempotencyKey: `career-customer-${user.uid}` },
      );
      customerId = customer.id;
      await db
        .collection("users")
        .updateOne(
          { uid: user.uid },
          { $set: { stripeCustomerId: customerId } },
        );
    }
    const active = await stripe().subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    if (
      active.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    )
      throw apiError(
        409,
        "You already have a subscription. Use Manage billing to change it.",
      );
    const returnUrl = new URL(process.env.APP_URL || "http://localhost:5173")
      .origin;
    const session = await stripe().checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: id, quantity: 1 }],
        success_url: `${returnUrl}/pricing?checkout=success`,
        cancel_url: `${returnUrl}/pricing?checkout=cancelled`,
        integration_identifier: `career_connect_${randomBytes(8).toString("hex").replace(/[0-9]/g, "a").slice(0, 8)}`,
      },
      {
        idempotencyKey: `career-checkout-${user.uid}-${plan}-${cycle}-${Math.floor(Date.now() / 600000)}`,
      },
    );
    return session.url;
  } finally {
    await lock.release();
  }
}
module.exports = {
  stripe,
  webhook,
  checkout,
  handleEvent,
  syncCustomer,
  priceId,
  pricePlan,
};

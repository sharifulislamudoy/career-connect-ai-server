const Stripe = require("stripe");
const { randomBytes, createHash } = require("node:crypto");
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
  if (typeof id !== "string" || !id) return null;
  for (const p of catalog().filter((p) => p.id !== "basic"))
    for (const cycle of ["monthly", "yearly"])
      if (priceId(p.id, cycle) === id) return { plan: p.id, cycle };
  return null;
}
// Use invoice price lines, never the current subscription price, to prove which
// tier was actually paid for. Upgrade invoices also contain negative credits.
async function recordPaidInvoice(
  db,
  invoice,
  subscription,
  { trustedPaidEvent = false } = {},
) {
  if (invoice.status !== "paid" && !trustedPaidEvent) return;
  const customerId = objectId(invoice.customer);
  if (customerId !== objectId(subscription.customer))
    throw apiError(503, "Invoice customer mismatch.");
  const invoiceSubscription = objectId(
    invoice.parent?.subscription_details?.subscription || invoice.subscription,
  );
  if (invoiceSubscription !== subscription.id) return;
  const user = await db
    .collection("users")
    .findOne({ stripeCustomerId: customerId });
  if (!user) throw apiError(503, "Customer mapping pending.");
  let lines = invoice.lines?.data || [];
  if (invoice.lines?.has_more) {
    lines = [];
    for await (const line of stripe().invoices.listLineItems(invoice.id, {
      limit: 100,
    }))
      lines.push(line);
  }
  const rank = { basic: 0, standard: 1, premium: 2 };
  const billedLine = lines
    .filter(
      (line) =>
        line.amount >= 0 &&
        pricePlan(objectId(line.pricing?.price_details?.price || line.price)),
    )
    .sort(
      (a, b) =>
        (b.period?.end || 0) - (a.period?.end || 0) ||
        rank[
          pricePlan(objectId(b.pricing?.price_details?.price || b.price)).plan
        ] -
          rank[
            pricePlan(objectId(a.pricing?.price_details?.price || a.price)).plan
          ],
    )[0];
  if (!billedLine)
    throw apiError(
      503,
      "Paid invoice has no recognized subscription price line.",
    );
  const mapped = pricePlan(
    objectId(billedLine.pricing?.price_details?.price || billedLine.price),
  );
  if (invoice.currency !== "bdt")
    throw apiError(503, "Unexpected invoice currency. This catalog uses BDT.");
  const accessThrough = new Date((billedLine.period?.end || 0) * 1000);
  if (!(+accessThrough > 0))
    throw apiError(503, "Invoice billing period is missing.");
  await db.collection("payments").updateOne(
    { stripeInvoiceId: invoice.id },
    {
      $set: { plan: mapped.plan, billingCycle: mapped.cycle, accessThrough },
      $setOnInsert: {
        stripeInvoiceId: invoice.id,
        userId: user.uid,
        userEmail: user.email,
        customerId,
        subscriptionId: subscription.id,
        currency: invoice.currency,
        amountMinor: invoice.amount_paid,
        refundedMinor: 0,
        status: "completed",
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
        completedAt: new Date(
          (invoice.status_transitions?.paid_at || invoice.created) * 1000,
        ),
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}
async function recoverPaidInvoices(db, subscription) {
  // Repair missed/delayed invoice.paid webhooks from authenticated Stripe data.
  // Recover only the latest paid invoices, enough to cover the current period.
  const invoices = await stripe().invoices.list({
    customer: objectId(subscription.customer),
    subscription: subscription.id,
    status: "paid",
    limit: 100,
  });
  for (const invoice of invoices.data)
    await recordPaidInvoice(db, invoice, subscription);
}
let portalConfig;
async function portalConfiguration() {
  const ids = catalog()
    .filter((p) => p.id !== "basic")
    .flatMap((p) => ["monthly", "yearly"].map((c) => priceId(p.id, c)))
    .filter(Boolean);
  const key = createHash("sha256").update(ids.join(",")).digest("hex");
  if (portalConfig?.key === key) return portalConfig.id;
  const products = new Map();
  for (const id of ids) {
    const price = await stripe().prices.retrieve(id);
    const product = objectId(price.product);
    if (!product) throw apiError(503, "Stripe price product is missing.");
    products.set(product, [...(products.get(product) || []), id]);
  }
  const config = await stripe().billingPortal.configurations.create(
    {
      business_profile: { headline: "Creative Career AI billing" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "always_invoice",
          products: [...products].map(([product, prices]) => ({
            product,
            prices,
          })),
        },
      },
    },
    { idempotencyKey: `career-portal-v1-${key}` },
  );
  portalConfig = { key, id: config.id };
  return config.id;
}
async function portal(user, flowData) {
  if (!user.stripeCustomerId) throw apiError(400, "No billing account yet.");
  const returnUrl = new URL(process.env.APP_URL || "http://localhost:5173")
    .origin;
  const session = await stripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    configuration: await portalConfiguration(),
    return_url: `${returnUrl}/pricing?billing=returned`,
    ...(flowData
      ? {
          flow_data: {
            ...flowData,
            after_completion: {
              type: "redirect",
              redirect: { return_url: `${returnUrl}/pricing?billing=returned` },
            },
          },
        }
      : {}),
  });
  return session.url;
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
    const validGrants = invoices.filter(
      (p) =>
        (p.amountMinor === 0 || (p.refundedMinor || 0) < p.amountMinor) &&
        new Date(p.accessThrough || expiry) > new Date(),
    );
    // Stripe can give the renewal and upgrade the same paid_at second.
    const grant =
      validGrants.find(
        (p) => p.plan === mapped.plan && p.billingCycle === mapped.cycle,
      ) || validGrants[0];
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
async function syncCustomer(db, customerId, { recover = false } = {}) {
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
    if (chosen) {
      if (recover) await recoverPaidInvoices(db, chosen);
      await reconcile(db, chosen, lock);
    } else {
      await db.collection("users").updateOne(
        { uid: user.uid },
        {
          $set: {
            package: "basic",
            packageExpiry: new Date(0),
            subscriptionStatus: "none",
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          },
        },
      );
    }
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
      await recordPaidInvoice(db, invoice, sub, { trustedPaidEvent: true });
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
      await db.collection("payment_refunds").updateOne(
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
      await db.collection("payments").updateOne(
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
    const existing = active.data
      .filter((s) => !["canceled", "incomplete_expired"].includes(s.status))
      .sort((a, b) => b.created - a.created);
    if (existing.length > 1)
      throw apiError(
        409,
        "Multiple subscriptions found. Open Manage billing before changing your plan.",
      );
    if (existing.length) {
      const subscription = existing[0];
      const item = subscription.items.data[0];
      if (
        subscription.items.data.length !== 1 ||
        !pricePlan(objectId(item?.price))
      )
        throw apiError(
          409,
          "This subscription must be managed through billing support.",
        );
      if (
        !["active", "trialing"].includes(subscription.status) ||
        subscription.pending_update
      )
        return await portal({ ...user, stripeCustomerId: customerId });
      if (objectId(item.price) === id)
        throw apiError(
          409,
          "You already have this plan and billing cycle. Refresh your billing status.",
        );
      return await portal(
        { ...user, stripeCustomerId: customerId },
        {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: subscription.id,
            items: [{ id: item.id, price: id, quantity: item.quantity || 1 }],
          },
        },
      );
    }
    const returnUrl = new URL(process.env.APP_URL || "http://localhost:5173")
      .origin;
    const session = await stripe().checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: id, quantity: 1 }],
        success_url: `${returnUrl}/pricing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
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
  portal,
  recordPaidInvoice,
};
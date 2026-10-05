module.exports = async (db) => {
  for (const [collection, key, options] of [
    ["users", { uid: 1 }, { unique: true }],
    ["usage_months", { userId: 1, period: 1 }, { unique: true }],
    ["usage_lifetime", { userId: 1 }, { unique: true }],
    ["usage_events", { requestId: 1 }, { unique: true }],
    ["usage_events", { userId: 1, createdAt: -1 }, {}],
    ["usage_windows", { userId: 1 }, { unique: true }],
    ["payment_refunds", { chargeId: 1 }, { unique: true }],
    ["stripe_events", { eventId: 1 }, { unique: true }],
    [
      "payments",
      { stripeInvoiceId: 1 },
      {
        unique: true,
        partialFilterExpression: { stripeInvoiceId: { $type: "string" } },
      },
    ],
    ["email_outbox", { key: 1 }, { unique: true }],
    ["account_reviews", { userId: 1, banId: 1 }, { unique: true }],
    [
      "notifications",
      { deliveryKey: 1 },
      {
        unique: true,
        partialFilterExpression: { deliveryKey: { $type: "string" } },
      },
    ],
    [
      "users",
      { stripeCustomerId: 1 },
      {
        unique: true,
        partialFilterExpression: { stripeCustomerId: { $type: "string" } },
      },
    ],
  ])
    await db.collection(collection).createIndex(key, options);
};

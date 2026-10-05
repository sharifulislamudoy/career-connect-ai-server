require("dotenv").config();
const { stripe } = require("../services/billing");
const { catalog } = require("../config/plans");
(async () => {
  const client = stripe();
  for (const plan of catalog().filter((p) => p.id !== "basic")) {
    const product = await client.products.create(
      { name: `Career Connect AI ${plan.name}` },
      { idempotencyKey: `career-product-${plan.id}` },
    );
    for (const cycle of ["monthly", "yearly"]) {
      const price = await client.prices.create(
        {
          product: product.id,
          currency: "bdt",
          unit_amount: plan[cycle],
          recurring: { interval: cycle === "monthly" ? "month" : "year" },
        },
        { idempotencyKey: `career-price-${plan.id}-${cycle}-${plan[cycle]}` },
      );
      console.log(
        `STRIPE_PRICE_${plan.id.toUpperCase()}_${cycle.toUpperCase()}=${price.id}`,
      );
    }
  }
})().catch((error) => {
  console.error("Catalog setup failed:", error.message);
  process.exitCode = 1;
});

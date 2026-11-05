// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, portrait_avatar/open-character-ai/src/app/api/stripe/checkout/route.js, seen in P5.
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

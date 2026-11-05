// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, portrait_avatar/open-character-ai/src/lib/stripe.js, seen in P5.
import Stripe from "stripe";
import config from "./config";

const apiKey = config.stripe.secretKey && config.stripe.secretKey.trim() !== ""
  ? config.stripe.secretKey
  : "sk_test_placeholder_key_for_build_purposes";

export const stripe = new Stripe(apiKey, {
  apiVersion: "2023-10-16",
});

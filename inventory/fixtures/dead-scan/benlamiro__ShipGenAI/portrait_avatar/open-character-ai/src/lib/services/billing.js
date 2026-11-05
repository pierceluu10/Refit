// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, portrait_avatar/open-character-ai/src/lib/services/billing.js, seen in P5.
import { stripe } from "../stripe";
import config from "../config";
import { UserService } from "./user";

export const BillingService = {
  async createCheckoutSession(userId, planId) {
    const plan = config.stripe.plans[planId];
    if (!plan) throw new Error("Invalid plan selected");

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {

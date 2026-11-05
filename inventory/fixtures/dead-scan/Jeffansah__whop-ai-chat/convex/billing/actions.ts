// Excerpt of Jeffansah/whop-ai-chat, convex/billing/actions.ts, seen in P5.
import { action } from "../_generated/server";
import { WhopServerSdk } from "@whop/api";

export const createCheckout = action({
  handler: async (ctx, { targetPlan }) => {
    const whopApi = WhopServerSdk({ appApiKey: process.env.WHOP_API_KEY! });
    const checkoutSession = await whopApi.payments.createCheckoutSession({
      planId: targetPlan.whopPlanId,
    });
    return checkoutSession;
  },
});

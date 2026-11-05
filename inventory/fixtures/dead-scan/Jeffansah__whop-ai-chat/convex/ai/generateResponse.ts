// Excerpt of Jeffansah/whop-ai-chat, convex/ai/generateResponse.ts, seen in P5.
import { api } from "../_generated/api";

export const notify = async (ctx: any, args: any) =>
  ctx.runAction(api.notifications.whop.notifySupportAgents, args);
export const onboard = async (ctx: any, args: any) =>
  ctx.runAction(api.onboarding.actions.onboardUser, args);
export const checkout = async (ctx: any, args: any) =>
  ctx.runAction(api.billing.actions.createCheckout, args);

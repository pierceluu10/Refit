// Excerpt of Jeffansah/whop-ai-chat, convex/notifications/whop.ts, seen in P5.
"use node";

import { action } from "../_generated/server";
import { getWhopSdk } from "../lib/whop";

export const sendHandoffNotification = action({
  handler: async (ctx, { customerWhopUserId, agentName, experienceId }) => {
    const whopSdk = getWhopSdk();
    await whopSdk.notifications.sendPushNotification({
      title: agentName,
      experienceId,
    });
  },
});

export const notifySupportAgents = action({
  handler: async (ctx, { title, experienceId }) => {
    const whopSdk = getWhopSdk();
    await whopSdk.notifications.sendPushNotification({
      title,
      experienceId,
    });
  },
});

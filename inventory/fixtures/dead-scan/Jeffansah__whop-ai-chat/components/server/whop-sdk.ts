// Excerpt of Jeffansah/whop-ai-chat, components/server/whop-sdk.ts, seen in P5.
"use server";

import { getWhopSdk } from "@/convex/lib/whop";
import { headers } from "next/headers";

export async function verifyUserToken() {
  const headersList = await headers();
  const whopSdk = getWhopSdk();
  const { userId } = await whopSdk.verifyUserToken(headersList);
  let username = "unknown";
  try {
    const whopUser = await whopSdk.users.getUser({ userId });
    username = whopUser.username || "unknown";
  } catch (error) {
    console.warn("[verifyUserToken] Failed to fetch username:", error);
  }
  return { success: true, userId, username };
}

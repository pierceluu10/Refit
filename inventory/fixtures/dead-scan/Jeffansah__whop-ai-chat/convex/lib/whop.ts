// Excerpt of Jeffansah/whop-ai-chat, convex/lib/whop.ts, seen in P5.
import { WhopServerSdk } from "@whop/api";

export const getWhopSdk = () =>
  WhopServerSdk({
    appApiKey: process.env.WHOP_API_KEY!,
    appId: process.env.NEXT_PUBLIC_WHOP_APP_ID!,
  });

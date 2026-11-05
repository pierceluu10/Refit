// Excerpt of Jeffansah/whop-ai-chat, app/experiences/[experienceId]/layout.tsx, seen in P5.
import { verifyUserToken } from "@/components/server/whop-sdk";

export default async function Layout({ children }: any) {
  await verifyUserToken();
  return children;
}

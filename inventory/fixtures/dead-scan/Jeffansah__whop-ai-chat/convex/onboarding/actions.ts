// Excerpt of Jeffansah/whop-ai-chat, convex/onboarding/actions.ts, seen in P5.
import { action } from "../_generated/server";
import { getWhopSdk } from "../lib/whop";

export const onboardUser = action({
  handler: async (ctx, { whopUserId, experienceId, companyId }) => {
    const whopSdk = getWhopSdk();
    const accessCheck = await whopSdk.access.checkIfUserHasAccessToExperience(
      {
        userId: whopUserId,
        experienceId,
      }
    );
    const experience = await whopSdk.experiences.getExperience({
      experienceId,
    });
    const whopCompany = await whopSdk.companies.getCompany({
      companyId,
    });
    const whopUser = await whopSdk.users.getUser({ userId: whopUserId });
    return { accessCheck, experience, whopCompany, whopUser };
  },
});

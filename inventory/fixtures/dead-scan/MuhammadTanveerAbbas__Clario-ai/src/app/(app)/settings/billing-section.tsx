// Excerpt of MuhammadTanveerAbbas/Clario-ai at 1cb1754244fc, src/app/(app)/settings/billing-section.tsx.
// The app's own profile row, which has the same field name as Stripe's.
export const nextBillingDate = (profile) =>
  profile?.current_period_end ? new Date(profile.current_period_end) : undefined;

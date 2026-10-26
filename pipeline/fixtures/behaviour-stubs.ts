import type { BehaviourStub, BehaviourTest } from '../behaviour-tests.ts';

// Anassarwar14/Chat-Nest-AI at 38dd23e1031c5fdad36e3a830092f00d519baac6 (dev-30), one of the 12
// repositories whose behaviour-test request in refit-bench run 40276445481 returned no tests: its
// Stripe calls sit behind Clerk, a Prisma client and next/headers. app/api/stripe/route.ts,
// app/api/webhook/route.ts, lib/stripe.ts and lib/prismaDB.ts as committed (trailing whitespace
// dropped); lib/utils.ts cut to absoluteURL, whose module also imports clsx and tailwind-merge;
// tsconfig.json cut to its paths.
export const CHAT_NEST_ROUTE = `import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import prismadb from "@/lib/prismaDB";
import { stripe } from "@/lib/stripe";
import { absoluteURL } from "@/lib/utils";


const settingsURL = absoluteURL("/settings");


export async function GET() {
    try {
        const { userId } = await auth();
        const user = await currentUser();

        if(!userId || !user){
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const userSubscription = await prismadb.userSubscription.findUnique({
            where: {
                userId
            }
        });

        if (userSubscription && userSubscription.stripeCustomerId) {
            const stripeSession = await stripe.billingPortal.sessions.create({
                customer: userSubscription.stripeCustomerId,
                return_url: settingsURL
            })

            return new NextResponse(JSON.stringify({ url: stripeSession.url }))
        }

        const stripeSession = await stripe.checkout.sessions.create({
            success_url: settingsURL,
            cancel_url: settingsURL,
            payment_method_types: ["card"],
            mode: "subscription",
            billing_address_collection: "auto",
            customer_email: user.emailAddresses[0].emailAddress,
            line_items: [
                {
                    price_data: {
                        currency: "USD",
                        product_data:{
                            name: "GrowNest Pro",
                            description: "Create Custom AI Characters",
                        },
                        unit_amount: 999,
                        recurring: {
                            interval: "month"
                        }
                    },
                    quantity: 1,
                }
            ],
            metadata: {
                userId
            }
        })


        return new NextResponse(JSON.stringify({ url: stripeSession.url}));
    } catch (error) {
        console.log("[STRIPE_GET]", error);
        return new NextResponse("Internal Error", { status: 500 })
    }
}`;

export const chatNestClient = (version: string) => `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_API_KEY!, {
    apiVersion: "${version}",
    typescript: true
})`;

export const CHAT_NEST_WEBHOOK = `import Stripe from "stripe";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import prismadb from "@/lib/prismaDB";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
    const body = await req.text();
    const signature = (await headers()).get("Stripe-Signature") as string;

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(
            body,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET!
        )
    } catch (error: any) {
        return new NextResponse(\`Webhook Error: \${error.message}\`, { status: 400 });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    if(event.type === "checkout.session.completed"){
        const subscription = await stripe.subscriptions.retrieve(
            session.subscription as string
        );


        if(!session?.metadata?.userId){
            return new NextResponse("User id is required", { status: 400})
        }

        await prismadb.userSubscription.create({
            data: {
                userId: session?.metadata?.userId,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: subscription.customer as string,
                stripePriceId: subscription.items.data[0].price.id,
                stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000)
            },
        });
    }

    if(event.type === "invoice.payment_succeeded"){
        const subscription = await stripe.subscriptions.retrieve(
            session.subscription as string
        );

        await prismadb.userSubscription.update({
            where: {
                stripeSubscriptionId: subscription.id,
            },
            data: {
                stripePriceId: subscription.items.data[0].price.id,
                stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000),
            }
        })
    }

    return new NextResponse(null, { status: 200 });

}`;

export const CHAT_NEST = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  'app/api/stripe/route.ts': CHAT_NEST_ROUTE,
  'app/api/webhook/route.ts': CHAT_NEST_WEBHOOK,
  'lib/stripe.ts': chatNestClient('2024-12-18.acacia'),
  'lib/prismaDB.ts': `import { PrismaClient } from "@prisma/client";

declare global {
    var prisma: PrismaClient | undefined;
}

const prismadb = globalThis.prisma || new PrismaClient();

if(process.env.NODE_ENV !== "production") globalThis.prisma = prismadb;

export default prismadb;`,
  'lib/utils.ts': `export function absoluteURL(path: string) {
  return \`\${process.env.NEXT_PUBLIC_APP_URL}\${path}\`;
}
`,
};

// The card rule's patch (docs/STRIPE-PAYMENT-METHOD-TYPES.md) with the endive pin, and the same
// patch keeping the parameter endive removed.
export const chatNestPatch = (version: string, parameter = 'allowed_payment_method_types') => ({
  ...CHAT_NEST,
  'lib/stripe.ts': chatNestClient(version),
  'app/api/stripe/route.ts': CHAT_NEST_ROUTE.replace(
    'payment_method_types: ["card"],',
    `${parameter}: ["card"],`,
  ),
});

// What a writer with --behaviour-test-stubs returns for the checkout route: Clerk signs a user in
// and the Prisma client finds no subscription, so GET reaches the Checkout Session it creates. The
// stubs replace a package and a repository file; the Stripe client and the route run as committed.
export const CHAT_NEST_STUBS: BehaviourStub[] = [
  {
    module: '@clerk/nextjs/server',
    path: 'refit-behaviour/stubs/clerk-server.mjs',
    content: `let user = null;
export const signIn = (value) => {
  user = value;
};
export async function auth() {
  return { userId: user?.id ?? null };
}
export async function currentUser() {
  return user && { id: user.id, emailAddresses: [{ emailAddress: user.email }] };
}
`,
  },
  {
    module: 'lib/prismaDB.ts',
    path: 'refit-behaviour/stubs/prisma-db.mjs',
    content: `export const subscriptions = new Map();
export default {
  userSubscription: {
    findUnique: async ({ where }) => subscriptions.get(where.userId) ?? null,
  },
};
`,
  },
];

export const CHAT_NEST_TEST: BehaviourTest = {
  path: 'refit-behaviour/checkout.test.mjs',
  content: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeRequests, resetStripeRequests } from 'refit:behaviour';
import { signIn } from './stubs/clerk-server.mjs';

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
const { GET } = await import('../app/api/stripe/route.ts');

test('sends a signed-in user without a subscription to a card-only Checkout Session', async () => {
  signIn({ id: 'user_1', email: 'buyer@example.com' });
  resetStripeRequests();
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(JSON.parse(await response.text()).url, /^https:\\/\\/checkout\\.stripe\\.com\\//);
  assert.equal(stripeRequests.length, 1);
  const [request] = stripeRequests;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/checkout/sessions');
  assert.equal(request.body.mode, 'subscription');
  assert.equal(request.body.customer_email, 'buyer@example.com');
  assert.equal(request.body.success_url, 'https://app.example.com/settings');
  assert.deepEqual(request.body.metadata, { userId: 'user_1' });
  assert.deepEqual(request.body.payment_method_types ?? request.body.allowed_payment_method_types, ['card']);
});
`,
};

// Emmah-oo/spotify-clone at 23f84d4d703ea005c12f60bc9ae42148158cc0f8 (dev-30), another of the 12:
// libs/supabaseAdmin.ts creates its Supabase client itself and reads the customer before the Stripe
// call, so the stub replaces the @supabase/supabase-js package, never the file, which holds the
// findings. libs/stripe.ts and libs/helpers.ts as committed; libs/supabaseAdmin.ts cut to the client
// and manageSubscriptionStatusChange's Stripe path, as behaviour-test-writer.test.ts cuts it.
export const SPOTIFY = {
  'libs/stripe.ts': `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2023-10-16",
  appInfo: {
    name: "Spotify Clone",
    version: "0.1.0",
  },
});
`,
  'libs/helpers.ts': `// Define a function named toDateTime to convert seconds to a Date object
export const toDateTime = (secs: number) => {
  // Create a new Date object with a base date of "1970-01-01T00:30:00Z"
  var t = new Date("1970-01-01T00:30:00Z");

  // Set the seconds of the Date object to the provided value
  t.setSeconds(secs);

  // Return the updated Date object
  return t;
};
`,
  'libs/supabaseAdmin.ts': `import { createClient } from "@supabase/supabase-js";

import { stripe } from "./stripe";
import { toDateTime } from "./helpers";

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  // Get customer's UUID from mapping table.
  const { data: customerData, error: noCustomerError } = await supabaseAdmin
    .from("customers")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (noCustomerError) throw noCustomerError;

  const { id: uuid } = customerData!;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });
  const subscriptionData = {
    id: subscription.id,
    user_id: uuid,
    current_period_start: toDateTime(
      subscription.current_period_start
    ).toISOString(),
    current_period_end: toDateTime(
      subscription.current_period_end
    ).toISOString(),
  };

  const { error } = await supabaseAdmin
    .from("subscriptions")
    .upsert([subscriptionData]);
  if (error) throw error;
};

export { manageSubscriptionStatusChange };
`,
};

export const SPOTIFY_STUB: BehaviourStub = {
  module: '@supabase/supabase-js',
  path: 'refit-behaviour/stubs/supabase.mjs',
  content: `export const rows = { customers: { id: 'user_uuid_1' } };
export const writes = [];
export function createClient() {
  return {
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: rows[table] ?? null, error: rows[table] ? null : { message: 'No rows' } }),
        upsert: async (values) => {
          writes.push({ table, values });
          return { error: null };
        },
      };
      return query;
    },
  };
}
`,
};

export const SPOTIFY_TEST: BehaviourTest = {
  path: 'refit-behaviour/subscription-status.test.mjs',
  content: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writes } from './stubs/supabase.mjs';

const { manageSubscriptionStatusChange } = await import('../libs/supabaseAdmin.ts');
const { toDateTime } = await import('../libs/helpers.ts');

test('stores the subscription and its billing period for the mapped customer', async () => {
  writes.length = 0;
  await manageSubscriptionStatusChange('sub_1', 'cus_1');
  assert.equal(writes.length, 1);
  const [{ table, values: [row] }] = writes;
  assert.equal(table, 'subscriptions');
  assert.equal(row.id, 'sub_1');
  assert.equal(row.user_id, 'user_uuid_1');
  assert.equal(row.current_period_start, toDateTime(1700000000).toISOString());
  assert.equal(row.current_period_end, toDateTime(1702592000).toISOString());
});
`,
};

// MuhammadTanveerAbbas/Clario-ai at 1cb1754244fcec19b23e8ce809606a20a24920a9 (dev-30), another of
// the 12: its checkout route reaches Supabase auth through '@/lib/supabase/server', which reads
// cookies() from next/headers. src/app/api/stripe/create-checkout/route.ts and
// src/lib/supabase/server.ts as committed.
export const CLARIO_ROUTE = `import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/middleware/rate-limit";
import { getPriceId } from "@/config/plans";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-02-25.clover" });

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const rateLimitCheck = checkRateLimit(request as any, 'api')
    if (!rateLimitCheck.allowed) {
      return rateLimitCheck.response!
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { plan, billing } = await request.json() as { plan: string; billing: "monthly" | "annual" };

    if (plan !== "pro") {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const priceId = getPriceId(billing);

    if (!priceId) {
      return NextResponse.json({ error: "Price ID not configured" }, { status: 500 });
    }

    const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { userId: user.id },
      customer_email: user.email,
      success_url: \`\${origin}/dashboard?upgrade=success\`,
      cancel_url: \`\${origin}/pricing\`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create checkout session";
    console.error("Stripe create-checkout error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
`;

export const CLARIO_SERVER = `import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { COOKIE_CONFIG, SESSION_CONFIG } from '../security-config'

type CookieToSet = {
  name: string
  value: string
  options?: Record<string, unknown>
}

export async function createClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable')
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable')
  }

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Ignore - called from Server Component
          }
        },
      },
      auth: {
        flowType: 'pkce',
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    }
  )
}

`;

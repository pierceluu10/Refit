// Excerpt of MuhammadTanveerAbbas/Clario-ai at 1cb1754244fc, src/app/api/stripe/webhook/route.ts.
import { stripe } from '@/lib/stripe';
import Stripe from 'stripe';

export async function handle(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        periodEnd = new Date((subscription as any).current_period_end * 1000).toISOString();
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const periodEnd = new Date((sub as any).current_period_end * 1000).toISOString();
      await supabase.from('subscriptions').upsert({
        current_period_start: new Date((sub as any).current_period_start * 1000).toISOString(),
        current_period_end: periodEnd,
      });
      break;
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as any;
      const subscriptionId = invoice.subscription as string | null;
      if (subscriptionId && typeof subscriptionId === 'string') {
        const updatedSub = await stripe.subscriptions.retrieve(subscriptionId);
        const periodEnd = new Date((updatedSub as any).current_period_end * 1000).toISOString();
      }
      break;
    }
    case 'invoice.payment_failed': {
      const failedInvoice = event.data.object as any;
      const subscriptionId = failedInvoice.subscription as string | null;
      break;
    }
  }
}

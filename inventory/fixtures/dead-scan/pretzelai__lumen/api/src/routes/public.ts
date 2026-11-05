// Excerpt of pretzelai/lumen at c689c56b3241, api/src/routes/public.ts. The app's own invoice row.
import { db } from '../db/client';

export const dunning = async (invoiceId) => {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (invoice?.subscription && invoice.subscription.status !== 'canceled') {
    await getOrCreateDunningConfig(invoice.subscription.merchantId, invoice.subscription.planId);
  }
};

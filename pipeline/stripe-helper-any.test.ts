import ts from 'typescript-compiler';
import { expect, it } from 'vitest';
import {
  CHECKOUT_SHIPPING_HELPER,
  INVOICE_SUBSCRIPTION_HELPER,
  PRODUCT_FEATURES_HELPER,
  subscriptionPeriodHelperModule,
} from './stripe-subscription-periods.ts';

// Type errors in `usage` compiled after the generated TypeScript helpers, under strict mode.
function typeErrors(usage: string) {
  const helpers = subscriptionPeriodHelperModule(
    'ts',
    [INVOICE_SUBSCRIPTION_HELPER, CHECKOUT_SHIPPING_HELPER, PRODUCT_FEATURES_HELPER],
    true,
  );
  const name = '/check.ts';
  const text = `${helpers}\n${usage}\nexport {};\n`;
  const options = { strict: true, noEmit: true, lib: ['lib.es2022.d.ts'], types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version) =>
    file === name ? ts.createSourceFile(file, text, version) : read(file, version);
  host.fileExists = (
    (exists) => (file: string) =>
      file === name || exists(file)
  )(host.fileExists);
  const program = ts.createProgram([name], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

// 0-CYBERDYNE-SYSTEMS-0/quorum server/routes.ts: `event.data.object as any` passed on as a string.
it('keeps an any receiver any, as the read it replaces was', () => {
  expect(
    typeErrors(`declare function byId(id: string): void;
declare const invoice: any;
declare const session: any;
declare const product: any;
const subscription = getInvoiceSubscription(invoice);
if (subscription) byId(subscription);
byId(getCheckoutShippingDetails(session).name);
byId(getProductMarketingFeatures(product)[0].name);`),
  ).toEqual([]);
});

it('still types a declared receiver from the field it reads', () => {
  expect(
    typeErrors(`declare const legacy: { subscription: string | null };
declare const moved: { parent: { subscription_details: { subscription: string } | null } | null };
const a: string | null = getInvoiceSubscription(legacy);
const b: string | null = getInvoiceSubscription(moved);
const c: number = getInvoiceSubscription(legacy);`),
  ).toEqual([expect.stringContaining("not assignable to type 'number'")]);
});

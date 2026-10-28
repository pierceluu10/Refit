// Shapes of the type errors a stripe-node upgrade introduces into application code
// (docs/UPGRADE-FALLOUT.md). The lane says who owns a shape: `type-only` is lane B's assertion
// repair, `request-rule` and `api-version` belong to the existing rules and are never an AI target,
// `cascade` follows from another error, and `behaviour` is what the upgrade-fallout repair may
// change, following the documented replacement, once Stripe's test mode can prove it.
export type FalloutLane = 'behaviour' | 'type-only' | 'request-rule' | 'api-version' | 'cascade';

export interface FalloutShape {
  shape: string;
  lane: FalloutLane;
  // The removed or changed Stripe member, such as `Invoice.subscription`, when the message names one.
  member?: string;
}

const REQUEST_OPTIONS = new Set(['apiKey', 'idempotencyKey', 'stripeAccount', 'stripeVersion']);
const PROPERTY = /^Property '(\w+)' does not exist on type '(?:Response<)?([\w.]+)>?'/;
const PARAMETER = /'(\w+)' does not exist in type '([\w.]+)'/;
const ASSIGNMENT =
  /^(?:Type|Argument of type) '(.+)' is not assignable to (?:type|parameter of type) '(.+)'/;
const API_VERSION = /^"\d{4}-\d{2}-\d{2}(?:\.\w+)?"$/;

export function falloutShape(error: { code: string; message: string }): FalloutShape {
  const { code, message } = error;
  const property = PROPERTY.exec(message);
  if ((code === 'TS2339' || code === 'TS2551') && property) {
    const [, name, type] = property;
    if (type === 'unknown' || type === 'never') return { shape: 'cascade', lane: 'cascade' };
    return type.endsWith('Resource')
      ? { shape: 'removed-method', lane: 'behaviour', member: `${type}.${name}` }
      : { shape: 'removed-field', lane: 'behaviour', member: `${type}.${name}` };
  }
  if (code === 'TS2694') {
    const name = /has no exported member '(\w+)'/.exec(message)?.[1];
    return { shape: 'removed-type', lane: 'behaviour', ...(name ? { member: name } : {}) };
  }
  const parameter = PARAMETER.exec(message);
  if ((code === 'TS2353' || code === 'TS2561') && parameter) {
    const [, name, params] = parameter;
    return REQUEST_OPTIONS.has(name)
      ? { shape: 'request-options-in-params', lane: 'behaviour', member: `${params}.${name}` }
      : { shape: 'removed-request-parameter', lane: 'request-rule', member: `${params}.${name}` };
  }
  if (code === 'TS2554') return { shape: 'arity', lane: 'behaviour' };
  if (code === 'TS18047' || code === 'TS18048' || code === 'TS2531' || code === 'TS2532')
    return { shape: 'widened-null', lane: 'behaviour' };
  const assignment = ASSIGNMENT.exec(message);
  if ((code === 'TS2322' || code === 'TS2345') && assignment) {
    const [, value, target] = assignment;
    if (API_VERSION.test(value)) return { shape: 'api-version-literal', lane: 'api-version' };
    if (value === 'unknown') return { shape: 'cascade', lane: 'cascade' };
    // A Stripe enum type now open (`Status`, `Interval | null`) assigned to the literals it once was.
    const literals = target.split(' | ').every((part) => /^"[^"]*"$|^null$/.test(part));
    const named = value.split(' | ').every((part) => /^[A-Z][\w.]*$|^null$/.test(part));
    if (/\bOtherString\b/.test(value) || (literals && named))
      return { shape: 'widened-enum', lane: 'type-only' };
    // An expandable field (`string | Customer`) or a nullable value passed where a plain one is.
    if (/\| (?:null|undefined)$/.test(value) && !/\b(?:null|undefined)\b/.test(target))
      return { shape: 'widened-null', lane: 'behaviour' };
    if (/^string \| \w+/.test(value) && target === 'string')
      return { shape: 'expandable-field', lane: 'behaviour' };
    return { shape: 'changed-type', lane: 'behaviour' };
  }
  return { shape: 'cascade', lane: 'cascade' };
}

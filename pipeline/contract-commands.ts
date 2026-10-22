// The command that saves a missing contract, for the agents `refit agents --add` writes.
export function contractCommand(
  integration: string | undefined,
  side: 'before' | 'after',
  path: string,
) {
  switch (integration) {
    case 'stripe':
      return side === 'after'
        ? `refit stripe-snapshot --latest --output ${path}`
        : `refit stripe-snapshot --revision <stripe/openapi commit for the API version your code pins> --output ${path}`;
    case 'shopify':
      return `refit shopify-snapshot --version <${side === 'before' ? 'the Admin API version your code pins' : 'the version to move to'}> --output ${path}`;
    default:
      return `refit source-snapshot --provider ${integration ?? '<provider>'} --url <the provider's public OpenAPI URL> --output ${path}`;
  }
}

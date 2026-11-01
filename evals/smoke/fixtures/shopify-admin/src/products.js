const API_VERSION = '2024-01';

export async function listProducts(shop, token) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/products.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const body = await response.json();
  return body.products.map((product) => ({ id: product.id, title: product.title }));
}

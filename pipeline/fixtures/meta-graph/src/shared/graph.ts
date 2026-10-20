// Graph API base shared across the app.
export const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

export async function graphGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return (await response.json()) as T;
}

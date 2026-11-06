// Illustrative OAuth flow to X without PKCE.
export function authorizeUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read',
    state: 'xyz',
  });
  return `https://twitter.com/i/oauth2/authorize?${params}`;
}

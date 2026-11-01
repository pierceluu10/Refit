---
provider: twilio
kind: auth-change
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/docs/usage/requests-to-twilio
  - https://www.twilio.com/docs/iam/api-keys
  - https://www.twilio.com/docs/iam/api/authtoken
  - https://www.twilio.com/docs/usage/security
  - https://www.twilio.com/docs/usage/webhooks/webhooks-security
---

# Twilio auth changes

**How it works:**

- **REST calls use HTTP Basic.** Twilio recommends an API key (key SID `SK...` as the username, secret as the password). The Account SID plus Auth Token works but is the master credential ([requests](https://www.twilio.com/docs/usage/requests-to-twilio)).
- **There are three key types.**
  - Main: same power as the Auth Token.
  - Standard: no access to the Accounts or Keys resources.
  - Restricted: fine-grained permissions ([API keys](https://www.twilio.com/docs/iam/api-keys)).
- **The Auth Token also signs webhooks.** Rotating it touches inbound validation as well as outbound calls.

**Typical migrations:**

- **Auth Token → API key.** In SDKs: `twilio(apiKeySid, apiKeySecret, { accountSid })` in Node, and `Client(api_key, api_secret, account_sid)` in Python. The Account SID must still be passed, because the URL contains it.
- **Auth Token rotation.** Create a secondary token, deploy it, then POST `AuthTokens/Promote`. The old token dies immediately. API keys can't call the rotation endpoints (error 20003) ([Auth Token](https://www.twilio.com/docs/iam/api/authtoken)).
- **Webhook validation during rotation.** Validate with the primary token until the secondary is promoted ([security](https://www.twilio.com/docs/usage/security)).
- **Test credentials.** These are separate from live ones and work only against certain resources.

**Spotting it:** grep for `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SK[0-9a-f]{32}` patterns, `new Twilio(`, `twilio(`, `Client(`, `Twilio::REST::Client.new`, `Twilio.init(`, `TwilioClient.Init(`, `auth=(` in `requests` calls, `Authorization: Basic`, and `validateRequest`/`RequestValidator` (which take the Auth Token).

**What to check:**

- **Standard key scope.** Code that creates subaccounts or keys needs a Main key or the Auth Token. A Standard key gets 401/403 there.
- **Subaccount credentials.** Subaccounts need their own credentials. Regional accounts need regional credentials ([requests](https://www.twilio.com/docs/usage/requests-to-twilio)).
- **Webhook validator token.** Webhook validators must keep the Auth Token. An API key secret will fail every signature check.

**Pitfalls:**

- Never print or commit the values. Change env var names and docs, not the secrets.
- Twilio Functions with a hard-coded token can 403 for about a minute after rotation ([Auth Token](https://www.twilio.com/docs/iam/api/authtoken)).

`twilio_search_docs` covers the details.

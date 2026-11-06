// Illustrative fixtures for the three refit-dev sample repos. The real repos are private and were
// not reachable from the session that wrote these, so each one is a reconstruction from the
// description in MVP-PLAN.md section 5, not a copy. Replace them with the real files when they can
// be cloned; the tests find line numbers by text, so they keep working if lines move.
export type FixtureRepo = { repo: string; files: Record<string, string> };

export const DEMO_NODE_API: FixtureRepo = {
  repo: 'refit-dev/demo-node-api',
  files: {
    'README.md': '# demo-node-api\n\nA Refit demo repo (illustrative). Express on Node 18.\n',
    'package.json': `{
  "name": "demo-node-api",
  "version": "1.0.0",
  "engines": {
    "node": "18.x"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.18.2",
    "openai": "^3.3.0"
  }
}
`,
    '.nvmrc': '18\n',
    Dockerfile: 'FROM node:18\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "src/server.js"]\n',
    'src/server.js': `const express = require('express');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
app.use(express.json());
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// Answers support questions for end users.
app.post('/chat', async (req, res) => {
  const completion = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo-0301',
    messages: [{ role: 'user', content: req.body.message }],
  });
  res.json({ reply: completion.data.choices[0].message.content });
});

module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);
`,
    'test/server.test.js':
      "const test = require('node:test');\nconst app = require('../src/server.js');\ntest('exports an app', () => { if (!app) throw new Error('no app'); });\n",
    'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-node-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo-node-api
  template:
    metadata:
      labels:
        app: demo-node-api
    spec:
      containers:
        - name: api
          image: demo-node-api:latest
          ports:
            - containerPort: 3000
`,
    'k8s/ingress.yaml': `apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  name: demo-node-api
spec:
  rules:
    - host: api.demo.example
      http:
        paths:
          - path: /
            backend:
              serviceName: demo-node-api
              servicePort: 3000
`,
    'serverless.yml': `service: demo-node-api-jobs
provider:
  name: aws
  runtime: nodejs16.x
  region: us-east-1
functions:
  nightly:
    handler: src/jobs.nightly
    events:
      - schedule: rate(1 day)
`,
    'src/jobs.js': 'exports.nightly = async () => ({ ok: true });\n',
  },
};

export const DEMO_PYTHON_APP: FixtureRepo = {
  repo: 'refit-dev/demo-python-app',
  files: {
    'README.md': '# demo-python-app\n\nA Refit demo repo (illustrative). Flask on Python 3.9.\n',
    '.python-version': '3.9.18\n',
    'pyproject.toml': `[project]
name = "demo-python-app"
version = "0.1.0"
requires-python = ">=3.9"
dependencies = [
  "flask==2.0.3",
  "stripe==2.76.0",
]

[project.optional-dependencies]
test = ["pytest"]
`,
    'app.py': `import os

import stripe
from flask import Flask, render_template, request

app = Flask(__name__)
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")


@app.route("/checkout", methods=["GET"])
def checkout_page():
    return render_template("checkout.html")


@app.route("/pay", methods=["POST"])
def pay():
    charge = stripe.Charge.create(
        amount=int(request.form["amount"]),
        currency="eur",
        source=request.form["token"],
        receipt_email=request.form["email"],
    )
    return {"id": charge.id, "status": charge.status}
`,
    'templates/checkout.html': `<!doctype html>
<html>
  <head>
    <script src="https://js.stripe.com/v2/"></script>
  </head>
  <body>
    <form action="/pay" method="post" id="payment-form">
      <input type="email" name="email" placeholder="Email">
      <input type="text" data-stripe="number" placeholder="Card number">
      <button type="submit">Pay</button>
    </form>
  </body>
</html>
`,
    'tests/test_app.py': `from app import app


def test_checkout_page():
    client = app.test_client()
    assert client.get("/checkout").status_code == 200
`,
  },
};

export const DEMO_NEXT_WEB: FixtureRepo = {
  repo: 'refit-dev/demo-next-web',
  files: {
    'README.md':
      '# demo-next-web\n\nA Refit demo repo (illustrative). Next.js on an older major.\n',
    'package.json': `{
  "name": "demo-next-web",
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "jest"
  },
  "dependencies": {
    "@stripe/stripe-js": "^1.54.0",
    "next": "12.3.4",
    "react": "17.0.2",
    "react-dom": "17.0.2"
  },
  "browserslist": [
    "defaults",
    "ie 11"
  ]
}
`,
    '.github/workflows/ci.yml': `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-20.04
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: 16
      - run: npm ci
      - run: npm test
`,
    'pages/checkout.tsx': `import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY as string);

export default function Checkout() {
  async function pay() {
    const stripe = await stripePromise;
    const response = await fetch('/api/checkout-session', { method: 'POST' });
    const { id } = await response.json();
    await stripe?.redirectToCheckout({ sessionId: id });
  }
  return (
    <main>
      <h1>Checkout</h1>
      <script src="https://www.googletagmanager.com/gtag/js?id=G-DEMO" async />
      <div onClick={pay}>Pay now</div>
    </main>
  );
}
`,
    'components/CookieBanner.tsx': `import { useEffect, useState } from 'react';

export function CookieBanner() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Tracking starts before the visitor chooses.
    document.cookie = 'analytics_id=' + Math.random() + '; path=/';
    window.gtag?.('config', 'G-DEMO');
  }, []);
  if (!visible) return null;
  return (
    <div className="cookie-banner">
      We use cookies.
      <span onClick={() => setVisible(false)}>OK</span>
    </div>
  );
}
`,
    'pages/signup.tsx': `export default function Signup() {
  return (
    <form method="post" action="/api/signup">
      <img src="/logo.png" />
      <input type="email" name="email" placeholder="Email" />
      <input type="password" name="password" placeholder="Password" />
      <input type="date" name="birthday" />
      <div onClick={() => document.forms[0].submit()}>Create account</div>
    </form>
  );
}
`,
    'pages/_app.tsx': `import type { AppProps } from 'next/app';
import { CookieBanner } from '../components/CookieBanner';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <CookieBanner />
    </>
  );
}
`,
  },
};

export const SAMPLE_REPOS = [DEMO_NODE_API, DEMO_PYTHON_APP, DEMO_NEXT_WEB];

// 1-based line of the first line in `file` that contains `needle`. Throws when it is missing, so a
// changed fixture fails loudly instead of testing the wrong line.
export function lineOf(fixture: FixtureRepo, file: string, needle: string): number {
  const text = fixture.files[file];
  if (text === undefined) throw new Error(`${fixture.repo} has no ${file}`);
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`${fixture.repo}/${file} has no line with ${needle}`);
  return index + 1;
}

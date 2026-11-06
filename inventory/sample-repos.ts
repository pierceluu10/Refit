// Test fixtures, labelled as such: copies of the three private Refit demo repos, which are
// deliberately outdated, plus an invented monorepo. Files are verbatim except package-lock.json,
// which keeps only the direct dependencies. READMEs, stylesheets and test suites are left out.
export type RepoFiles = Record<string, string>;

// refit-dev/demo-node-api at 108d5e5.
export const DEMO_NODE_API: RepoFiles = {
  '.env.example': `OPENAI_API_KEY=
PORT=3000
`,
  '.nvmrc': `18
`,
  Dockerfile: `FROM node:18

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
`,
  'k8s/ingress.yaml': `apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  name: demo-node-api
spec:
  rules:
    - host: demo-node-api.example.com
      http:
        paths:
          - path: /
            backend:
              serviceName: demo-node-api
              servicePort: 3000
`,
  'package-lock.json': `{
  "name": "demo-node-api",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "demo-node-api",
      "version": "1.0.0",
      "dependencies": {
        "express": "4.18.2",
        "openai": "4.20.1"
      },
      "engines": {
        "node": "18.x"
      }
    },
    "node_modules/express": {
      "version": "4.18.2",
      "engines": {
        "node": ">= 0.10.0"
      }
    },
    "node_modules/openai": {
      "version": "4.20.1"
    }
  }
}
`,
  'package.json': `{
  "name": "demo-node-api",
  "version": "1.0.0",
  "private": true,
  "description": "Refit demo repo: a deliberately outdated Express API",
  "main": "src/server.js",
  "engines": {
    "node": "18.x"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "4.18.2",
    "openai": "4.20.1"
  }
}
`,
  'serverless.yml': `service: demo-node-api

provider:
  name: aws
  runtime: nodejs16.x
  region: us-east-1

functions:
  health:
    handler: src/handler.health
    events:
      - httpApi:
          path: /health
          method: get
`,
  'src/app.js': `const express = require('express');
const { summarize } = require('./summarize');

function createApp(openai) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/summaries', async (req, res) => {
    const { text } = req.body;
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      res.json({ summary: await summarize(openai, text) });
    } catch (error) {
      res.status(502).json({ error: 'summary failed' });
    }
  });

  return app;
}

module.exports = { createApp };
`,
  'src/handler.js': `async function health() {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  };
}

module.exports = { health };
`,
  'src/server.js': `const OpenAI = require('openai');
const { createApp } = require('./app');

const DEFAULT_PORT = 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const port = process.env.PORT || DEFAULT_PORT;

createApp(openai).listen(port, () => {
  console.log(\`demo-node-api listening on \${port}\`);
});
`,
  'src/summarize.js': `const MODEL = 'text-davinci-003';
const MAX_TOKENS = 200;

async function summarize(openai, text) {
  const completion = await openai.completions.create({
    model: MODEL,
    prompt: \`Summarize this in one sentence:\\n\\n\${text}\`,
    max_tokens: MAX_TOKENS,
  });
  return completion.choices[0].text.trim();
}

module.exports = { MODEL, summarize };
`,
};

// refit-dev/demo-python-app at b38cbf8.
export const DEMO_PYTHON_APP: RepoFiles = {
  '.env.example': `STRIPE_SECRET_KEY=
`,
  '.python-version': `3.9
`,
  'app.py': `import os

import stripe
from flask import Flask, jsonify, request

HTTP_BAD_REQUEST = 400
HTTP_PAYMENT_REQUIRED = 402


def create_app():
    app = Flask(__name__)
    stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.post("/charges")
    def create_charge():
        payload = request.get_json(silent=True) or {}
        amount = payload.get("amount")
        source = payload.get("source")
        if not isinstance(amount, int) or amount <= 0 or not source:
            return jsonify(error="amount and source are required"), HTTP_BAD_REQUEST

        try:
            charge = stripe.Charge.create(
                amount=amount,
                currency=payload.get("currency", "usd"),
                source=source,
            )
        except stripe.error.CardError as error:
            return jsonify(error=error.user_message), HTTP_PAYMENT_REQUIRED

        return jsonify(id=charge["id"], status=charge["status"])

    return app


app = create_app()
`,
  'pyproject.toml': `[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "demo-python-app"
version = "1.0.0"
description = "Refit demo repo: a deliberately outdated Flask app"
requires-python = ">=3.9,<3.10"
dependencies = [
    "flask==2.2.5",
    "werkzeug==2.2.3",
    "stripe==2.76.0",
]

[project.optional-dependencies]
dev = ["pytest==7.4.4"]

[tool.setuptools]
py-modules = ["app"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
`,
};

// refit-dev/demo-next-web at 36f8a55.
export const DEMO_NEXT_WEB: RepoFiles = {
  '.env.example': `STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
`,
  '.github/workflows/ci.yml': `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: 16
      - run: npm ci
      - run: npm test
      - run: npm run build
`,
  'components/CookieBanner.js': `import { useEffect, useState } from 'react';

const CONSENT_COOKIE = 'cookie_consent';
const ONE_YEAR_SECONDS = 31536000;

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    document.cookie = \`analytics_id=\${Date.now()}; path=/; max-age=\${ONE_YEAR_SECONDS}\`;
    setVisible(!document.cookie.includes(\`\${CONSENT_COOKIE}=\`));
  }, []);

  if (!visible) {
    return null;
  }

  function accept() {
    document.cookie = \`\${CONSENT_COOKIE}=yes; path=/; max-age=\${ONE_YEAR_SECONDS}\`;
    setVisible(false);
  }

  return (
    <div className="cookie-banner">
      <p>We use cookies to improve your experience.</p>
      <button onClick={accept}>OK</button>
    </div>
  );
}
`,
  'lib/plans.js': `const PLANS = {
  starter: { name: 'Fieldnote Starter', amount: 1900, currency: 'usd' },
  team: { name: 'Fieldnote Team', amount: 4900, currency: 'usd' },
};

function buildLineItem(planId) {
  if (!Object.prototype.hasOwnProperty.call(PLANS, planId)) {
    return null;
  }
  const plan = PLANS[planId];
  return {
    price_data: {
      currency: plan.currency,
      product_data: { name: plan.name },
      unit_amount: plan.amount,
    },
    quantity: 1,
  };
}

function isValidEmail(email) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

module.exports = { PLANS, buildLineItem, isValidEmail };
`,
  'package-lock.json': `{
  "name": "demo-next-web",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "demo-next-web",
      "version": "1.0.0",
      "dependencies": {
        "@stripe/stripe-js": "1.54.2",
        "next": "12.3.4",
        "react": "18.2.0",
        "react-dom": "18.2.0",
        "stripe": "8.222.0"
      }
    },
    "node_modules/@stripe/stripe-js": {
      "version": "1.54.2"
    },
    "node_modules/next": {
      "version": "12.3.4",
      "engines": {
        "node": ">=12.22.0"
      }
    },
    "node_modules/react": {
      "version": "18.2.0",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/react-dom": {
      "version": "18.2.0"
    },
    "node_modules/stripe": {
      "version": "8.222.0",
      "engines": {
        "node": "^8.1 || >=10.*"
      }
    }
  }
}
`,
  'package.json': `{
  "name": "demo-next-web",
  "version": "1.0.0",
  "private": true,
  "description": "Refit demo repo: a deliberately outdated Next.js site",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "node --test"
  },
  "dependencies": {
    "@stripe/stripe-js": "1.54.2",
    "next": "12.3.4",
    "react": "18.2.0",
    "react-dom": "18.2.0",
    "stripe": "8.222.0"
  }
}
`,
  'pages/_app.js': `import Script from 'next/script';
import CookieBanner from '../components/CookieBanner';
import '../styles/globals.css';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Script src="https://analytics.example.com/tag.js" strategy="afterInteractive" />
      <Component {...pageProps} />
      <CookieBanner />
    </>
  );
}
`,
  'pages/api/checkout-session.js': `import Stripe from 'stripe';
import { buildLineItem } from '../../lib/plans';

const STRIPE_API_VERSION = '2020-08-27';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const lineItem = buildLineItem(req.body.planId);
  if (!lineItem) {
    res.status(400).json({ error: 'Unknown plan' });
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  const origin = req.headers.origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      success_url: \`\${origin}/?paid=1\`,
      cancel_url: \`\${origin}/checkout\`,
    });
    res.status(200).json({ sessionId: session.id });
  } catch (error) {
    res.status(502).json({ error: 'Could not start checkout' });
  }
}
`,
  'pages/checkout.js': `import { loadStripe } from '@stripe/stripe-js';
import Head from 'next/head';
import Script from 'next/script';
import { useState } from 'react';
import { PLANS } from '../lib/plans';

export default function Checkout() {
  const [error, setError] = useState('');

  async function buy(planId) {
    setError('');
    const response = await fetch('/api/checkout-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    if (!response.ok) {
      setError('Checkout failed. Try again.');
      return;
    }
    const { sessionId } = await response.json();
    const stripe = await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
    const result = await stripe.redirectToCheckout({ sessionId });
    if (result.error) {
      setError(result.error.message);
    }
  }

  return (
    <main>
      <Head>
        <title>Fieldnote checkout</title>
      </Head>
      <Script src="https://chat-widget.example.com/widget.js" strategy="afterInteractive" />
      <div className="heading">Choose a plan</div>
      {Object.entries(PLANS).map(([id, plan]) => (
        <div className="plan" key={id}>
          <span>{plan.name}</span>
          <span>\${plan.amount / 100} a month</span>
          <button onClick={() => buy(id)}>Buy</button>
        </div>
      ))}
      <p className="message">{error}</p>
    </main>
  );
}
`,
  'pages/index.js': `import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';
import { isValidEmail } from '../lib/plans';

export default function Home() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  function submit() {
    setMessage(isValidEmail(email) ? 'Thanks for signing up.' : 'Invalid');
  }

  return (
    <main>
      <Head>
        <title>Fieldnote</title>
      </Head>
      <img src="/logo.svg" width="48" height="48" />
      <div className="heading">Notes for field teams</div>
      <p className="muted">Sign up for early access.</p>
      <div className="signup">
        <input
          type="text"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <div className="button" onClick={submit}>
          Sign up
        </div>
      </div>
      <p className="message">{message}</p>
      <Link href="/checkout">
        <a className="muted">Buy now</a>
      </Link>
    </main>
  );
}
`,
};

// Invented for tests, not a real repository: npm workspaces plus a Python service, where packages
// declare their own versions and two of them resolve the same framework differently.
export const MONOREPO: RepoFiles = {
  '.nvmrc': `20
`,
  'package.json': `{
  "name": "acme-monorepo",
  "private": true,
  "workspaces": ["apps/*"],
  "engines": {
    "node": ">=20"
  }
}
`,
  'package-lock.json': `{
  "name": "acme-monorepo",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "acme-monorepo",
      "workspaces": ["apps/*"]
    },
    "apps/admin": {
      "dependencies": {
        "next": "^13.5.0"
      }
    },
    "apps/admin/node_modules/next": {
      "version": "13.5.6"
    },
    "apps/web": {
      "dependencies": {
        "next": "^14.2.0",
        "openai": "^4.52.0"
      },
      "engines": {
        "node": "20.x"
      }
    },
    "node_modules/next": {
      "version": "14.2.3"
    },
    "node_modules/openai": {
      "version": "4.52.7"
    }
  }
}
`,
  'apps/web/package.json': `{
  "name": "@acme/web",
  "dependencies": {
    "next": "^14.2.0",
    "openai": "^4.52.0"
  },
  "engines": {
    "node": "20.x"
  }
}
`,
  'apps/web/Dockerfile': `ARG NODE_VERSION=20
FROM node:\${NODE_VERSION}-alpine AS build
RUN npm ci
FROM nginx:1.25-bookworm
`,
  'apps/web/src/ai.ts': `import OpenAI from 'openai';

const client = new OpenAI();
const model = process.env.CHAT_MODEL ?? 'gpt-4o';

export async function reply(text: string) {
  return client.chat.completions.create({ model, messages: [{ role: 'user', content: text }] });
}
`,
  'apps/admin/package.json': `{
  "name": "@acme/admin",
  "dependencies": {
    "next": "^13.5.0"
  }
}
`,
  'services/worker/.python-version': `3.11
`,
  'services/worker/pyproject.toml': `[tool.poetry]
name = "worker"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
django = "^4.2"
anthropic = "^0.25"
`,
  'services/worker/poetry.lock': `[[package]]
name = "anthropic"
version = "0.25.9"

[[package]]
name = "django"
version = "4.2.13"
`,
  'services/worker/Dockerfile': `FROM python:3.11-slim-bookworm
COPY . /app
`,
  'services/worker/worker.py': `import anthropic

client = anthropic.Anthropic()


def summarize(text):
    return client.messages.create(
        model="claude-3-opus-20240229",
        max_tokens=100,
        messages=[{"role": "user", "content": text}],
    )
`,
  '.github/workflows/ci.yml': `name: CI
on: push
jobs:
  test:
    strategy:
      matrix:
        node: [18, 20]
        os: [ubuntu-20.04, ubuntu-22.04]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: \${{ matrix.node }}
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      - uses: ./.github/actions/deploy
`,
};

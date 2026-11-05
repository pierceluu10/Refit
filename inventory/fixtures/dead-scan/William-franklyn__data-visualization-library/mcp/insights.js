// Excerpt of William-franklyn/data-visualization-library, mcp/insights.js, seen in P5.
'use strict';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

async function generateInsightsWithOpenRouter(prompt, apiKey) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  return res.json();
}

module.exports = { generateInsightsWithOpenRouter };

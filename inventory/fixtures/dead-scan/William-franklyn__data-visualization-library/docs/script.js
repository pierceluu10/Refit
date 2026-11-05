// Excerpt of William-franklyn/data-visualization-library, docs/script.js, seen in P5.
/* To change the fallback model: https://openrouter.ai/models */
const AI_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

async function askAI(prompt) {
  const res = await fetch('/api/ai', {
    method: 'POST',
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  return res.json();
}

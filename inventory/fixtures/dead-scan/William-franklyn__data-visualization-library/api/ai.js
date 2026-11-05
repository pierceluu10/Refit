// Excerpt of William-franklyn/data-visualization-library, api/ai.js, seen in P5.
module.exports = async (req, res) => {
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(req.body),
  });
  res.status(upstream.status).json(await upstream.json());
};

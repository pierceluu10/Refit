const express = require('express');
const { summarise } = require('./summarise');

const app = express();
app.use(express.json());

app.post('/summary', async (req, res) => {
  res.json({ summary: await summarise(req.body.text) });
});

module.exports = { app };

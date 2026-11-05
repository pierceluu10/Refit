// Excerpt of elnazar535-coder/eleko-bot, index.js, seen in P5.
const express = require('express');
const twilio = require('twilio');
const app = express();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function sendMessage(to, body) {
  return client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${to}`,
    body,
  });
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const from = req.body.From?.replace('whatsapp:', '');
  await sendMessage(from, 'Received');
});

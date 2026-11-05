// Excerpt of Jmk125/ConstructionDocuments, server.js, seen in P5.
const { initDatabase } = require('./database');
const { initAI, generateResponse } = require('./lib/aiHandler');
const chat = require('./lib/chatHandler');
initDatabase();
initAI();
chat.start(generateResponse);

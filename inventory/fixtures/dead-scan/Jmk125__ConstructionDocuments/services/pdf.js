// Excerpt of Jmk125/ConstructionDocuments, services/pdf.js, seen in P5. ../db/database isn't in the repo.
const pdf = require('pdf-parse');
const { createEmbedding } = require('./openai');
const { run } = require('../db/database');
exports.embed = async (buffer) => run(await createEmbedding((await pdf(buffer)).text));

// Excerpt of AyeletHillel/fine-tune, src/index.ts, seen in P5.
import OpenAI from 'openai';

const client = new OpenAI();

async function mainShort() {
  await client.fineTuning.jobs.create({
    model: 'gpt-3.5-turbo',
    training_file: 'file',
  });
}

async function main() {
  await client.fineTuning.jobs.create({ model: 'gpt-3.5-turbo', training_file: 'file' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

## File uploads

Request parameters that correspond to file uploads can be passed in many different forms:

- `File` (or an object with the same structure)
- a `fetch` `Response` (or an object with the same structure)
- an `fs.ReadStream`
- the return value of our `toFile` or `toStreamingFile` helpers

```ts
import fs from 'fs';
import OpenAI, { toFile, toStreamingFile } from 'openai';

const client = new OpenAI();

// If you have access to Node `fs` we recommend using `fs.createReadStream()`:
await client.files.create({ file: fs.createReadStream('input.jsonl'), purpose: 'fine-tune' });

// Or if you have the web `File` API you can pass a `File` instance:
await client.files.create({ file: new File(['my bytes'], 'input.jsonl'), purpose: 'fine-tune' });

// You can also pass a `fetch` `Response`:
await client.files.create({
  file: await fetch('https://somesite/input.jsonl'),
  purpose: 'fine-tune',
});

// Finally, if none of the above are convenient, you can use our `toFile` helper:
await client.files.create({
  file: await toFile(Buffer.from('my bytes'), 'input.jsonl'),
  purpose: 'fine-tune',
});
await client.files.create({
  file: await toFile(new Uint8Array([0, 1, 2]), 'input.jsonl'),
  purpose: 'fine-tune',
});

// `toFile()` creates a web File, so it must buffer stream inputs before sending them.
// Use `toStreamingFile()` to stream an arbitrary web, Node, or cloud-storage stream directly:
await client.files.create({
  file: toStreamingFile(myReadableStream, 'input.jsonl', { type: 'application/jsonl' }),
  purpose: 'fine-tune',
});
```


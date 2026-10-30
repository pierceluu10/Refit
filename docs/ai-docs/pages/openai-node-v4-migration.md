v4 is a complete rewrite of the SDK. To see what's new, see [the release notes](https://github.com/openai/openai-node/discussions/182).

## Installation
First, update your `package.json` to specify v4:

```json
  "openai": "^4.0.0"
```
and run `npm install` or equivalent to download the new version.

<h2 id="automatic-migration">Automatic migration</h2>

You can automatically migrate your codebase using [grit](https://grit.io), either [online](https://app.grit.io/migrations/new/openai_v4) or with the following CLI command:

```sh
npm exec openai migrate
```

The grit binary executes entirely locally with AST-based transforms. 

Be sure to audit its changes: we suggest ensuring you have a clean working tree beforehand, and running `git add --patch` afterwards. Note that grit.io also offers opt-in automatic fixes powered by AI.

## Manual migration

There are changes in the initialization logic, method names, error handling. The API parameter names should be unchanged.

#### Initialization
```typescript
// Old
import { Configuration, OpenAIApi } from "openai";

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// New
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // This is also the default, can be omitted
});
```

#### Creating a chat completion
```typescript
// Old
const chatCompletion = await openai.createChatCompletion({
  model: "gpt-3.5-turbo",
  messages: [{role: "user", content: "Hello world"}],
});
console.log(chatCompletion.data.choices[0].message);

// New
const chatCompletion = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",
  messages: [{"role": "user", "content": "Hello!"}],
});
console.log(chatCompletion.choices[0].message);
```

#### Creating a streaming chat completion (new)
```typescript
// Old
// Not supported

// New
const stream = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",
  messages: [{"role": "user", "content": "Hello!"}],
  stream: true,
});
for await (const part of stream) {
  console.log(part.choices[0].delta);
}
```

#### Creating a completion
```typescript
// Old
const completion = await openai.createCompletion({
  model: "text-davinci-003",
  prompt: "This story begins",
  max_tokens: 30,
});
console.log(completion.data.choices[0].text);

// New
const completion = await openai.completions.create({
  model: "text-davinci-003",
  prompt: "This story begins",
  max_tokens: 30,
});
console.log(completion.choices[0].text);
```

#### Creating a transcription (whisper)
```typescript
// Old
const response = await openai.createTranscription(
  fs.createReadStream("audio.mp3"),
  "whisper-1"
);

// New
const response = await openai.audio.transcriptions.create({
  model: 'whisper-1',
  file: fs.createReadStream('audio.mp3'),
});
```

#### Creating a streaming completion (new)
```typescript
// Old
// Not supported

// New
const stream = await openai.completions.create({
  model: "text-davinci-003",
  prompt: "This story begins",
  max_tokens: 30,
  stream: true,
});
for await (const part of stream) {
  console.log(part.choices[0]);
}
```

#### Error handling
```typescript
// Old
try {
  const completion = await openai.createCompletion({...});
} catch (error) {
  if (error.response) {
    console.log(error.response.status); // e.g. 401
    console.log(error.response.data.message); // e.g. The authentication token you passed was invalid...
    console.log(error.response.data.code); // e.g. 'invalid_api_key'
    console.log(error.response.data.type); // e.g. 'invalid_request_error'
  } else {
    console.log(error);
  }
}

// New
try {
  const response = await openai.completions.create({...});
} catch (error) {
  if (error instanceof OpenAI.APIError) {
    console.error(error.status);  // e.g. 401
    console.error(error.message); // e.g. The authentication token you passed was invalid...
    console.error(error.code);  // e.g. 'invalid_api_key'
    console.error(error.type);  // e.g. 'invalid_request_error'
  } else {
    // Non-API error
    console.log(error);
  }
}
```

### Headers

```ts
// Old
const response = openai.createChatCompletion(params)
response.headers['x-ratelimit-remaining-tokens']
response.data.id

// New
const { data, response } = openai.chat.completions.create(params).withResponse()
response.headers.get('x-ratelimit-remaining-tokens')
data.id
```

### All method name changes

_To migrate these automatically, see [Automatic migration](#user-content-automatic-migration), above_

- `createFineTune` -> `fineTunes.create`
- `cancelFineTune` -> `fineTunes.cancel`
- `retrieveFineTune` -> `fineTunes.retrieve`
- `listFineTunes` -> `fineTunes.list`
- `listFineTuneEvents` -> `fineTunes.listEvents`

- `createFile` -> `files.create`
- `deleteFile` -> `files.del`
- `retrieveFile` -> `files.retrieve`
- `downloadFile` -> `files.retrieveContent`
- `listFiles` -> `files.list`

- `deleteModel` -> `models.del`
- `listModels` -> `models.list`
- `retrieveModel` -> `models.retrieve`

- `createImage` -> `images.generate`
- `createImageEdit` -> `images.edit`
- `createImageVariation` -> `images.createVariation`

- `createChatCompletion` -> `chat.completions.create`

- `createCompletion` -> `completions.create`

- `createTranscription` -> `audio.transcriptions.create`
- `createTranslation` -> `audio.translations.create`

- `createEdit` -> `edits.create`
- `createEmbedding` -> `embeddings.create`
- `createModeration` -> `moderations.create`

Removed:
- `createAnswer()`
- `createClassification()`
- `createSearch()`
- `listEngines()`
- `retrieveEngine()`

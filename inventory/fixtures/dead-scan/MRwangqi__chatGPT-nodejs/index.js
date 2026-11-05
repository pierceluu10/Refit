// Excerpt of MRwangqi/chatGPT-nodejs, index.js, seen in P5.
import { Configuration, OpenAIApi } from "openai";

const configuration = new Configuration({ apiKey: process.env.APP_KEY });
const openai = new OpenAIApi(configuration);
const response = await openai.listEngines();

console.log(response.status);

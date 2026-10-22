import { traceFiles } from './pipeline/python/models.ts';
const files = [
 { path: 'app/config.py', content: `import os\nMODEL = os.getenv("OPENAI_MODEL", "gpt-4")\nFAST = "gpt-3.5-turbo"\n` },
 { path: 'app/llm.py', content: `from openai import OpenAI, AsyncOpenAI
import anthropic
from .config import MODEL
from app import config
client = OpenAI()
def ask(q, model="gpt-4o"):
    return client.chat.completions.create(model=model, messages=[], temperature=0)
ask("x", model="gpt-4-turbo")
class Bot:
    def __init__(self, model: str = "claude-3-opus-20240229"):
        self.client = anthropic.AsyncAnthropic(base_url="http://x")
        self.model = model
    async def run(self):
        return await self.client.messages.create(model=self.model, max_tokens=5)
r = client.responses.create(model=MODEL)
r2 = client.embeddings.create(model=config.FAST, input="x")
params = {"model": "gpt-4", "messages": []}
client.chat.completions.create(**params)
client.chat.completions.create(**kw)
Bot(model="claude-2")
` },
 { path: 'g.py', content: `from google import genai\nc = genai.Client()\nc.models.generate_content(model="gemini-2.0-flash", contents="x")\nc.aio.models.generate_content(model=os.environ["M"])\n` },
];
console.log(JSON.stringify(await traceFiles(files), null, 1));

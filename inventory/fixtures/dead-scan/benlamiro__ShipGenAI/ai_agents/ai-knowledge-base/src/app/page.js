// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, ai_agents/ai-knowledge-base/src/app/page.js, seen in P5.
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850 rounded-lg px-2.5 py-2 text-[10px] font-black text-zinc-300 focus:outline-none focus:border-indigo-500/40 transition-all cursor-pointer shadow-sm"
              >
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="google/gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="openai/gpt-4o">GPT-4o (Premium)</option>
                <option value="anthropic/claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="meta-llama/llama-3.1-70b-instruct">Llama 3.1 70B</option>
              </select>

// LLM provider registry. The agent engine asks for a provider by name and
// gets back a uniform `{ runWithTools(...) }` adapter. Adding a provider is a
// new file in this folder + one line below — the engine code never branches
// on provider name.
//
// Each adapter exports a single async function with this contract:
//
//   runWithTools({
//     systemPrompt: string,
//     messages: Array<{ role: 'user'|'assistant', content: string }>,
//     tools: Array<{ name, description, input_schema }>,
//     onToolCall: async ({ name, args }) => any,    // executes one tool and returns result
//     onStep: async (step) => void,                 // emits llm_call / tool_call traces
//     model: string,
//     apiKey: string,
//     maxIterations: number,
//   }) -> { finalText, totalInputTokens, totalOutputTokens, iterations }
//
// `tools` follows the Anthropic-style shape because it's the simpler superset;
// the OpenAI adapter translates internally. `onToolCall` errors are caught by
// the adapter and fed back to the model as a tool error — the loop continues
// until the model stops asking for tools (or maxIterations).

const anthropic = require('./anthropic');
const openai = require('./openai');

const PROVIDERS = {
  anthropic,
  openai,
};

// Typed unknown-provider failure (carries the code callers match on).
class UnknownProviderError extends Error {
  constructor(name) {
    super(`Unknown LLM provider: ${name}`);
    this.name = 'UnknownProviderError';
    this.code = 'UNKNOWN_PROVIDER';
  }
}

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) {
    throw new UnknownProviderError(name);
  }
  return p;
}

function listProviders() {
  return Object.keys(PROVIDERS);
}

// Test seam: replaces ONLY the external-model boundary for hermetic tests
// (the qualification/execution flow above it stays real). Never used in
// production paths.
function __setProviderForTests(name, impl) {
  PROVIDERS[name] = impl;
}

function __resetProvidersForTests() {
  for (const key of Object.keys(PROVIDERS)) {
    if (key !== 'anthropic' && key !== 'openai') delete PROVIDERS[key];
  }
}

module.exports = { getProvider, listProviders, __setProviderForTests, __resetProvidersForTests };

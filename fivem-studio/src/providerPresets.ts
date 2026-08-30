// Model-backend presets.
//
// Nearly every provider — hosted and local — exposes an OpenAI-compatible
// chat-completions API, so "adding a provider" is a base URL and a model name
// rather than new code. Only Anthropic gets a dedicated implementation, because
// it has its own wire format (and its own thinking-block semantics).
//
// Free-tier terms, endpoints, and model names all change: every field here is
// editable in Settings, and "Custom" exists for anything not listed.

import { canonicalAgentEndpoint } from "../electron/agentProviderPolicy";

export interface ProviderPreset {
  id: string;
  label: string;
  /** Empty for Anthropic — it doesn't go through the OpenAI-compatible path. */
  baseUrl: string;
  model: string;
  /** Shown under the picker. */
  note: string;
  cost: "free" | "free-tier" | "paid";
  needsKey: boolean;
  /** Where to get a key, when one is needed. */
  keyUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.7-flash",
    note: "Free tier, no credit card required. Good tool calling — the easiest way to get the agent running.",
    cost: "free-tier",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    note: "Free developer limits are available. Fast inference with strong coding, reasoning, and tool use.",
    cost: "free-tier",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash",
    note: "One key for many models, including some free ones (look for ':free' model ids). Daily cap on the free tier.",
    cost: "free-tier",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    note: "Free tier available on La Plateforme.",
    cost: "free-tier",
    needsKey: true,
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder",
    note: "Completely free and offline — runs on your own hardware, no account. Start it with `ollama serve`, then `ollama pull qwen2.5-coder`.",
    cost: "free",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    note: "Completely free and offline. Load a model in LM Studio, start its local server, then put the model's id here.",
    cost: "free",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    note: "Paid — requires billing set up on your OpenAI account.",
    cost: "paid",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "",
    model: "claude-opus-5",
    note: "Paid — requires API credits. Uses Anthropic's native API, including extended thinking.",
    cost: "paid",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "custom",
    label: "Custom (any OpenAI-compatible endpoint)",
    baseUrl: "",
    model: "",
    note: "Point at any server that speaks the OpenAI chat-completions API — vLLM, llama.cpp, DeepSeek, Together, a proxy, anything.",
    cost: "paid",
    needsKey: false,
  },
];

export const COST_LABEL: Record<ProviderPreset["cost"], string> = {
  free: "Free",
  "free-tier": "Free tier",
  paid: "Paid",
};

/** Which preset a saved config corresponds to, so the picker reopens where the user left it. */
export function matchPreset(provider: "anthropic" | "openai", baseUrl: string): ProviderPreset {
  if (provider === "anthropic") return PROVIDER_PRESETS.find((p) => p.id === "anthropic")!;
  const canonical = canonicalAgentEndpoint(baseUrl);
  return (
    PROVIDER_PRESETS.find((p) => p.baseUrl && canonicalAgentEndpoint(p.baseUrl) === canonical) ??
    PROVIDER_PRESETS.find((p) => p.id === "custom")!
  );
}

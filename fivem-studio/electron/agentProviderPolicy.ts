/**
 * Shared, dependency-free policy for endpoints built into QB Studio. This file
 * is imported by both the main process and the renderer, so recognizing a
 * preset can never hide a credential-policy mismatch that main would accept.
 */

const GEMINI_OPENAI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/";

const KNOWN_KEYED_OPENAI_ENDPOINTS = [
  GEMINI_OPENAI_ENDPOINT,
  "https://api.groq.com/openai/v1",
  "https://openrouter.ai/api/v1",
  "https://api.mistral.ai/v1",
  "https://api.openai.com/v1",
] as const;

export function canonicalAgentEndpoint(value: string): string | null {
  try {
    const endpoint = new URL(value);
    if (endpoint.username || endpoint.password) return null;
    if (endpoint.pathname !== "/") endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    return endpoint.toString();
  } catch {
    return null;
  }
}

const KEYED_ENDPOINTS = new Set(
  KNOWN_KEYED_OPENAI_ENDPOINTS.map((endpoint) => canonicalAgentEndpoint(endpoint)),
);

/** Custom hosted endpoints may deliberately be keyless. Only endpoints whose
 * built-in contract is known are forced to require a credential. */
export function isKnownKeyedOpenAIEndpoint(value: string): boolean {
  const canonical = canonicalAgentEndpoint(value);
  return canonical !== null && KEYED_ENDPOINTS.has(canonical);
}

export function isGeminiOpenAIEndpoint(value: string): boolean {
  const canonical = canonicalAgentEndpoint(value);
  return canonical !== null && canonical === canonicalAgentEndpoint(GEMINI_OPENAI_ENDPOINT);
}

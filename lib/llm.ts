import { anthropic } from "@ai-sdk/anthropic";
import { DEFAULT_LLM_MODEL, isLlmModelId, type LlmStep, type ModelPrefs } from "./llm-models";
import { requireEnv } from "./errors";

/**
 * Resolve the model for a pipeline step from the book's per-step preferences.
 * Unknown/absent preferences (or no step at all) fall back to the default.
 */
export function getModel(step?: LlmStep, prefs?: ModelPrefs | null) {
  requireEnv("ANTHROPIC_API_KEY");
  const preferred = step ? prefs?.[step] : undefined;
  return anthropic(isLlmModelId(preferred) ? preferred : DEFAULT_LLM_MODEL);
}

/** Split text into chunks of roughly `size` chars, breaking at paragraph boundaries. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > size) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
    // A single paragraph longer than size: hard-split it
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

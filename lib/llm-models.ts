// Client-safe model metadata: no SDK imports so UI components can use it.

export const LLM_MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced (default)" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Highest quality" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "Fastest & cheapest" },
] as const;

export type LlmModelId = (typeof LLM_MODELS)[number]["id"];

export type LlmStep = "analyze" | "cast" | "script";

export const LLM_STEPS: { step: LlmStep; label: string; description: string }[] = [
  { step: "analyze", label: "Analysis", description: "Find characters & narrator" },
  { step: "cast", label: "Casting", description: "Match voices to characters" },
  { step: "script", label: "Scripting", description: "Attribute dialogue speakers" },
];

export type ModelPrefs = Partial<Record<LlmStep, LlmModelId>>;

export const DEFAULT_LLM_MODEL: LlmModelId = "claude-sonnet-5";

export function isLlmModelId(value: unknown): value is LlmModelId {
  return LLM_MODELS.some((m) => m.id === value);
}

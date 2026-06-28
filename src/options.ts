import { z } from "zod";

export const searchContextSizeSchema = z.enum(["low", "medium", "high"]);

const openaiOptionsSchema = z
  .object({
    model: z.string().min(1).optional(),
    contextSize: searchContextSizeSchema.optional(),
    instructions: z.string().min(1).optional(),
  })
  .strict();

const pluginOptionsSchema = z
  .object({
    provider: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    openai: openaiOptionsSchema.optional(),
  })
  .strict();

export type SearchContextSize = z.infer<typeof searchContextSizeSchema>;

export type PluginConfig = {
  provider: string;
  toolName: string;
  openai: {
    model: string;
    contextSize: SearchContextSize;
    instructions: string;
  };
};

const DEFAULT_MODEL = "openai/gpt-5.5";
const DEFAULT_INSTRUCTIONS =
  "Answer the user's query using web search results. Ground factual claims in the retrieved sources. If the sources do not contain enough evidence, state what is missing instead of guessing.";

export function parsePluginOptions(options: Record<string, unknown> | undefined): PluginConfig {
  const parsed = pluginOptionsSchema.parse(options ?? {});
  return {
    provider: parsed.provider ?? "openai",
    toolName: parsed.toolName ?? "websearch",
    openai: {
      model: parsed.openai?.model ?? process.env.OPENCODE_OPENAI_WEBSEARCH_MODEL ?? DEFAULT_MODEL,
      contextSize: parsed.openai?.contextSize ?? "medium",
      instructions: parsed.openai?.instructions ?? DEFAULT_INSTRUCTIONS,
    },
  };
}

import type { Config, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { AuthError } from "./auth.js";
import { openAiWebSearch, SearchApiError } from "./openai.js";
import { parsePluginOptions, searchContextSizeSchema } from "./options.js";
import { ProviderError, resolveSearchTarget } from "./provider.js";

function createWebsearchTool(
  config: ReturnType<typeof parsePluginOptions>,
  getOpencodeConfig: () => Config | undefined,
) {
  return tool({
    description:
      "Search the web when the answer requires current, external, or source-backed information. Returns an answer with citations when the provider supplies them.",
    args: {
      query: z
        .string()
        .min(1)
        .describe(
          "Specific question or search query. Include enough context to retrieve relevant sources.",
        ),
      contextSize: searchContextSizeSchema
        .optional()
        .describe(
          "Search context budget: low, medium, or high. Use high for broad or nuanced research.",
        ),
    },
    async execute(args, context) {
      const model = config.openai.model;
      let target: Awaited<ReturnType<typeof resolveSearchTarget>>;
      try {
        target = await resolveSearchTarget(model, config.provider, getOpencodeConfig());
      } catch (err) {
        if (err instanceof ProviderError) {
          return {
            title: `${config.toolName}: provider error`,
            output: `Error: ${err.message}\n\nHint: ${err.hint}`,
          };
        }
        if (err instanceof AuthError) {
          return {
            title: `${config.toolName}: authentication error`,
            output: `Error: ${err.message}\n\nHint: ${err.hint}`,
          };
        }
        throw err;
      }

      try {
        const result = await openAiWebSearch(
          target,
          config,
          {
            query: args.query,
            contextSize: args.contextSize,
          },
          { sessionId: context.sessionID },
          context.abort,
        );

        const citationLines =
          result.citations.length > 0
            ? result.citations
                .map((citation, index) => `[${index + 1}] ${citation.title}\n    ${citation.url}`)
                .join("\n")
            : "(no citations)";
        const output =
          result.citations.length > 0
            ? `${result.answer}\n\n---\nSources:\n${citationLines}`
            : result.answer;

        return {
          title: `${config.toolName}: ${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}`,
          output,
          metadata: {
            provider: result.provider,
            transport: result.transport,
            authSource: result.authSource,
            model: result.model,
            mode: "live",
            contextSize: args.contextSize ?? config.openai.contextSize,
            citations: result.citations,
          },
        };
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        if (err instanceof SearchApiError) {
          const hint = err.hint ? `\n\nHint: ${err.hint}` : "";
          return {
            title: `${config.toolName}: API error`,
            output: `Error: ${err.message}${hint}`,
            metadata: { statusCode: err.statusCode },
          };
        }
        throw err;
      }
    },
  });
}

export default (async (_input, options) => {
  const config = parsePluginOptions(options);
  let opencodeConfig: Config | undefined;
  return {
    async config(input) {
      opencodeConfig = input;
    },
    tool: {
      [config.toolName]: createWebsearchTool(config, () => opencodeConfig),
    },
  };
}) satisfies Plugin;

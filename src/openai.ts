import { arch, platform, release } from "node:os";
import type { OpenAiAuth } from "./auth.js";
import { buildOAuthHeaders } from "./auth.js";
import type { PluginConfig, SearchContextSize } from "./options.js";
import type { SearchTarget } from "./provider.js";
import { parseSseEventData, readErrorMessage, takeNextSseEvent } from "./sse.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const USER_AGENT = "opencode/1.17.8";
const WEBSEARCH_INCLUDE = ["web_search_call.action.sources"];

export type SearchParams = {
  query: string;
  contextSize?: SearchContextSize;
};

export type SearchCitation = {
  url: string;
  title: string;
};

export type SearchResult = {
  answer: string;
  citations: SearchCitation[];
  transport: "openai-responses" | "codex-responses" | "openai-compatible-responses";
  model: string;
  provider: string;
  authSource: SearchTarget["auth"]["source"];
};

export class SearchApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SearchApiError";
  }
}

type ResolvedSearchParams = {
  query: string;
  model: string;
  contextSize: SearchContextSize;
  instructions: string;
};

type ResponseOutputItem = {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: Array<{
      type?: string;
      url?: string;
      title?: string;
    }>;
  }>;
};

type ResponsesApiResponse = {
  output?: ResponseOutputItem[];
  error?: { message: string; type?: string; code?: string };
};

type SseEvent = {
  type?: string;
  item?: ResponseOutputItem;
  response?: {
    output?: ResponseOutputItem[];
  };
};

function resolveParams(config: PluginConfig, params: SearchParams): ResolvedSearchParams {
  return {
    query: params.query,
    model: config.openai.model,
    contextSize: params.contextSize ?? config.openai.contextSize,
    instructions: config.openai.instructions,
  };
}

function buildWebSearchTool(params: ResolvedSearchParams): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: true,
    search_context_size: params.contextSize,
  };
  return tool;
}

function buildInput(query: string): Array<{
  role: string;
  content: Array<{ type: string; text: string }>;
}> {
  return [{ role: "user", content: [{ type: "input_text", text: query }] }];
}

function buildRequestBody(params: ResolvedSearchParams, stream: boolean): Record<string, unknown> {
  return {
    model: params.model,
    instructions: params.instructions,
    input: buildInput(params.query),
    tools: [buildWebSearchTool(params)],
    include: WEBSEARCH_INCLUDE,
    store: false,
    ...(stream ? { stream: true } : {}),
  };
}

function extractAnswerFromOutput(output: ResponseOutputItem[]): string | null {
  const parts: string[] = [];

  for (const item of output) {
    if (item.type !== "message" || !item.content) continue;
    for (const block of item.content) {
      if (block.type === "output_text" && block.text) parts.push(block.text);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractCitationsFromOutput(output: ResponseOutputItem[]): SearchCitation[] {
  const citations: SearchCitation[] = [];
  const seen = new Set<string>();

  for (const item of output) {
    if (item.type !== "message" || !item.content) continue;
    for (const block of item.content) {
      for (const annotation of block.annotations ?? []) {
        if (annotation.type !== "url_citation" || !annotation.url || seen.has(annotation.url))
          continue;
        seen.add(annotation.url);
        citations.push({ url: annotation.url, title: annotation.title ?? annotation.url });
      }
    }
  }

  return citations;
}

function responseToResult(
  output: ResponseOutputItem[],
  transport: SearchResult["transport"],
  model: string,
  authSource: SearchResult["authSource"],
): Omit<SearchResult, "provider"> {
  if (output.length === 0) {
    throw new SearchApiError(`${transport} returned empty output array`);
  }

  const answer = extractAnswerFromOutput(output);
  if (answer === null) {
    throw new SearchApiError(
      `${transport} output contained no message with text content. Output types: ${output.map((item) => item.type ?? "unknown").join(", ")}`,
    );
  }

  return {
    answer,
    citations: extractCitationsFromOutput(output),
    transport,
    model,
    authSource,
  };
}

async function searchWithApiKey(
  auth: Extract<SearchTarget["auth"], { mode: "apikey" }>,
  params: ResolvedSearchParams,
  target: Extract<SearchTarget, { endpoint: "official" | "openai-compatible" }>,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const url = target.endpoint === "official" ? OPENAI_RESPONSES_URL : target.responsesUrl;
  const transport =
    target.endpoint === "official" ? "openai-responses" : "openai-compatible-responses";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(params, false)),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new SearchApiError(`Network error calling ${transport}: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    const hint =
      response.status === 401 ? "Check OPENAI_API_KEY or re-run `opencode auth login`." : undefined;
    throw new SearchApiError(`${transport} error: ${message}`, response.status, hint);
  }

  let json: ResponsesApiResponse;
  try {
    json = (await response.json()) as ResponsesApiResponse;
  } catch {
    throw new SearchApiError(
      `${transport} returned non-JSON response (status ${response.status})`,
      response.status,
    );
  }

  return {
    ...responseToResult(json.output ?? [], transport, params.model, auth.source),
    provider: target.providerID,
  };
}

async function searchWithOAuth(
  auth: Extract<OpenAiAuth, { mode: "oauth" }>,
  params: ResolvedSearchParams,
  ctx: { sessionId?: string; requestId?: string },
  signal?: AbortSignal,
): Promise<SearchResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: "opencode",
    ...buildOAuthHeaders(auth),
  };

  if (ctx.sessionId) {
    headers["session-id"] = ctx.sessionId;
    headers["x-client-request-id"] = ctx.requestId ?? ctx.sessionId;
  }

  let response: Response;
  try {
    response = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(params, true)),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new SearchApiError(
      `Network error calling Codex responses API: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    const hint =
      response.status === 401 || response.status === 403
        ? "Run `opencode auth login` or `codex login` to refresh OpenAI OAuth credentials."
        : undefined;
    throw new SearchApiError(`Codex responses API error: ${message}`, response.status, hint);
  }

  const output = await parseCompletedOutput(response, signal);
  return {
    ...responseToResult(output ?? [], "codex-responses", params.model, auth.source),
    provider: "openai",
  };
}

async function parseCompletedOutput(
  response: Response,
  signal?: AbortSignal,
): Promise<ResponseOutputItem[] | null> {
  if (!response.body) {
    throw new SearchApiError("Codex responses API returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedOutput: ResponseOutputItem[] | null = null;
  const outputItems: ResponseOutputItem[] = [];

  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let next = takeNextSseEvent(buffer);

      while (next) {
        buffer = next.rest;
        const parsed = parseSseEventData(next.rawEvent) as SseEvent | "[DONE]" | null;
        if (parsed && parsed !== "[DONE]") {
          if (parsed.type === "response.output_item.done" && parsed.item) {
            outputItems.push(parsed.item);
          } else if (parsed.type === "response.completed" && parsed.response?.output) {
            completedOutput = parsed.response.output;
          }
        }
        next = takeNextSseEvent(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (completedOutput && completedOutput.length > 0) return completedOutput;
  return outputItems.length > 0 ? outputItems : completedOutput;
}

export async function openAiWebSearch(
  target: SearchTarget,
  config: PluginConfig,
  params: SearchParams,
  ctx?: { sessionId?: string; requestId?: string },
  signal?: AbortSignal,
): Promise<SearchResult> {
  const resolved = { ...resolveParams(config, params), model: target.modelID };
  if (target.auth.mode === "apikey") return searchWithApiKey(target.auth, resolved, target, signal);
  return searchWithOAuth(target.auth, resolved, ctx ?? {}, signal);
}

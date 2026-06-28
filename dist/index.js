// src/index.ts
import { tool } from "@opencode-ai/plugin";
import { z as z3 } from "zod";

// src/auth.ts
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
var opencodeAuthSchema = z.object({
  openai: z.union([
    z.object({ type: z.literal("api"), key: z.string() }).passthrough(),
    z.object({
      type: z.literal("oauth"),
      access: z.string(),
      refresh: z.string().optional(),
      expires: z.number().optional(),
      accountId: z.string().optional()
    }).passthrough()
  ]).optional()
}).passthrough();
var codexTokensSchema = z.object({
  id_token: z.string().nullable().optional(),
  access_token: z.string().nullable().optional(),
  refresh_token: z.string().nullable().optional(),
  account_id: z.string().nullable().optional()
}).passthrough();
var codexAuthSchema = z.object({
  OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: codexTokensSchema.nullable().optional()
}).passthrough();
var AuthError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "AuthError";
  }
  hint;
};
function opencodeAuthPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}
function codexAuthPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
}
function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
async function loadOpencodeAuth() {
  const raw = await readJsonFile(opencodeAuthPath());
  if (!raw) return null;
  const parsed = opencodeAuthSchema.parse(raw);
  const openai = parsed.openai;
  if (!openai) return null;
  if (openai.type === "api") {
    return { mode: "apikey", apiKey: openai.key, source: "opencode" };
  }
  return {
    mode: "oauth",
    accessToken: openai.access,
    accountId: openai.accountId,
    source: "opencode"
  };
}
async function loadCodexAuth() {
  const raw = await readJsonFile(codexAuthPath());
  if (!raw) return null;
  const parsed = codexAuthSchema.parse(raw);
  if (parsed.OPENAI_API_KEY) {
    return { mode: "apikey", apiKey: parsed.OPENAI_API_KEY, source: "codex" };
  }
  if (!parsed.tokens?.access_token) return null;
  const claims = parsed.tokens.id_token ? decodeJwtPayload(parsed.tokens.id_token) : {};
  const claimAccountId = claims.chatgpt_account_id;
  return {
    mode: "oauth",
    accessToken: parsed.tokens.access_token,
    accountId: parsed.tokens.account_id ?? (typeof claimAccountId === "string" ? claimAccountId : void 0),
    fedramp: claims.chatgpt_account_is_fedramp === true,
    source: "codex"
  };
}
async function loadOpenAiAuth() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return { mode: "apikey", apiKey, source: "env" };
  }
  try {
    const opencodeAuth = await loadOpencodeAuth();
    if (opencodeAuth) return opencodeAuth;
  } catch (err) {
    throw new AuthError(
      `Failed to read opencode OpenAI auth: ${err.message}`,
      "Run `opencode auth login` again or remove the invalid opencode auth entry."
    );
  }
  try {
    const codexAuth = await loadCodexAuth();
    if (codexAuth) return codexAuth;
  } catch (err) {
    throw new AuthError(
      `Failed to read Codex OpenAI auth: ${err.message}`,
      "Run `codex login` again or remove the invalid Codex auth file."
    );
  }
  throw new AuthError(
    "No OpenAI credentials found.",
    "Run `opencode auth login`, run `codex login`, or set OPENAI_API_KEY."
  );
}
function buildOAuthHeaders(auth) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  if (auth.fedramp) headers["X-OpenAI-Fedramp"] = "true";
  return headers;
}

// src/sse.ts
function takeNextSseEvent(buffer) {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const candidates = [lfIndex, crlfIndex].filter((index) => index >= 0);
  if (candidates.length === 0) return null;
  const boundary = Math.min(...candidates);
  const separatorLength = boundary === crlfIndex ? 4 : 2;
  return {
    rawEvent: buffer.slice(0, boundary),
    rest: buffer.slice(boundary + separatorLength)
  };
}
function parseSseEventData(rawEvent) {
  const data = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trimStart()).join("\n").trim();
  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
async function readErrorMessage(response) {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const json = JSON.parse(text);
    return json.error?.message ?? json.message ?? text;
  } catch {
    return text;
  }
}

// src/openai.ts
var OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
var CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
var USER_AGENT = "opencode/1.17.8";
var WEBSEARCH_INCLUDE = ["web_search_call.action.sources"];
var SearchApiError = class extends Error {
  constructor(message, statusCode, hint) {
    super(message);
    this.statusCode = statusCode;
    this.hint = hint;
    this.name = "SearchApiError";
  }
  statusCode;
  hint;
};
function resolveParams(config, params) {
  return {
    query: params.query,
    model: config.openai.model,
    contextSize: params.contextSize ?? config.openai.contextSize,
    instructions: config.openai.instructions
  };
}
function buildWebSearchTool(params) {
  const tool2 = {
    type: "web_search",
    external_web_access: true,
    search_context_size: params.contextSize
  };
  return tool2;
}
function buildInput(query) {
  return [{ role: "user", content: [{ type: "input_text", text: query }] }];
}
function buildRequestBody(params, stream) {
  return {
    model: params.model,
    instructions: params.instructions,
    input: buildInput(params.query),
    tools: [buildWebSearchTool(params)],
    include: WEBSEARCH_INCLUDE,
    store: false,
    ...stream ? { stream: true } : {}
  };
}
function extractAnswerFromOutput(output) {
  const parts = [];
  for (const item of output) {
    if (item.type !== "message" || !item.content) continue;
    for (const block of item.content) {
      if (block.type === "output_text" && block.text) parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
function extractCitationsFromOutput(output) {
  const citations = [];
  const seen = /* @__PURE__ */ new Set();
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
function responseToResult(output, transport, model, authSource) {
  if (output.length === 0) {
    throw new SearchApiError(`${transport} returned empty output array`);
  }
  const answer = extractAnswerFromOutput(output);
  if (answer === null) {
    throw new SearchApiError(
      `${transport} output contained no message with text content. Output types: ${output.map((item) => item.type ?? "unknown").join(", ")}`
    );
  }
  return {
    answer,
    citations: extractCitationsFromOutput(output),
    transport,
    model,
    authSource
  };
}
async function searchWithApiKey(auth, params, target, signal) {
  const url = target.endpoint === "official" ? OPENAI_RESPONSES_URL : target.responsesUrl;
  const transport = target.endpoint === "official" ? "openai-responses" : "openai-compatible-responses";
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.apiKey}`
      },
      body: JSON.stringify(buildRequestBody(params, false)),
      signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new SearchApiError(`Network error calling ${transport}: ${err.message}`);
  }
  if (!response.ok) {
    const message = await readErrorMessage(response);
    const hint = response.status === 401 ? "Check OPENAI_API_KEY or re-run `opencode auth login`." : void 0;
    throw new SearchApiError(`${transport} error: ${message}`, response.status, hint);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new SearchApiError(
      `${transport} returned non-JSON response (status ${response.status})`,
      response.status
    );
  }
  return {
    ...responseToResult(json.output ?? [], transport, params.model, auth.source),
    provider: target.providerID
  };
}
async function searchWithOAuth(auth, params, ctx, signal) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: "opencode",
    ...buildOAuthHeaders(auth)
  };
  if (ctx.sessionId) {
    headers["session-id"] = ctx.sessionId;
    headers["x-client-request-id"] = ctx.requestId ?? ctx.sessionId;
  }
  let response;
  try {
    response = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(params, true)),
      signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new SearchApiError(
      `Network error calling Codex responses API: ${err.message}`
    );
  }
  if (!response.ok) {
    const message = await readErrorMessage(response);
    const hint = response.status === 401 || response.status === 403 ? "Run `opencode auth login` or `codex login` to refresh OpenAI OAuth credentials." : void 0;
    throw new SearchApiError(`Codex responses API error: ${message}`, response.status, hint);
  }
  const output = await parseCompletedOutput(response, signal);
  return {
    ...responseToResult(output ?? [], "codex-responses", params.model, auth.source),
    provider: "openai"
  };
}
async function parseCompletedOutput(response, signal) {
  if (!response.body) {
    throw new SearchApiError("Codex responses API returned no response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedOutput = null;
  const outputItems = [];
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let next = takeNextSseEvent(buffer);
      while (next) {
        buffer = next.rest;
        const parsed = parseSseEventData(next.rawEvent);
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
async function openAiWebSearch(target, config, params, ctx, signal) {
  const resolved = { ...resolveParams(config, params), model: target.modelID };
  if (target.auth.mode === "apikey") return searchWithApiKey(target.auth, resolved, target, signal);
  return searchWithOAuth(target.auth, resolved, ctx ?? {}, signal);
}

// src/options.ts
import { z as z2 } from "zod";
var searchContextSizeSchema = z2.enum(["low", "medium", "high"]);
var openaiOptionsSchema = z2.object({
  model: z2.string().min(1).optional(),
  contextSize: searchContextSizeSchema.optional(),
  instructions: z2.string().min(1).optional()
}).strict();
var pluginOptionsSchema = z2.object({
  provider: z2.string().min(1).optional(),
  toolName: z2.string().min(1).optional(),
  openai: openaiOptionsSchema.optional()
}).strict();
var DEFAULT_MODEL = "openai/gpt-5.5";
var DEFAULT_INSTRUCTIONS = "Answer the user's query using web search results. Ground factual claims in the retrieved sources. If the sources do not contain enough evidence, state what is missing instead of guessing.";
function parsePluginOptions(options) {
  const parsed = pluginOptionsSchema.parse(options ?? {});
  return {
    provider: parsed.provider ?? "openai",
    toolName: parsed.toolName ?? "web_search",
    openai: {
      model: parsed.openai?.model ?? process.env.OPENCODE_OPENAI_WEBSEARCH_MODEL ?? DEFAULT_MODEL,
      contextSize: parsed.openai?.contextSize ?? "medium",
      instructions: parsed.openai?.instructions ?? DEFAULT_INSTRUCTIONS
    }
  };
}

// src/provider.ts
var ProviderError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "ProviderError";
  }
  hint;
};
function splitModel(model, defaultProvider) {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: defaultProvider, modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
function responsesUrl(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}
function resolveEnvTemplate(value) {
  const match = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return value;
  return process.env[match[1]] ?? null;
}
function providerApiKey(providerID, provider) {
  if (provider.options?.apiKey) {
    const apiKey = resolveEnvTemplate(provider.options.apiKey);
    if (apiKey) return { apiKey, source: "provider-config" };
  }
  for (const envName of provider.env ?? []) {
    const value = process.env[envName];
    if (value) return { apiKey: value, source: "provider-env" };
  }
  const envFallback = process.env[`${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
  if (envFallback) return { apiKey: envFallback, source: "provider-env" };
  return null;
}
async function resolveSearchTarget(model, defaultProvider, config) {
  const { providerID, modelID } = splitModel(model, defaultProvider);
  if (!providerID || !modelID) {
    throw new ProviderError(
      `Invalid model "${model}".`,
      "Use provider/model format, for example `openai/gpt-5.5` or `custom_provider/gpt-5.5`."
    );
  }
  if (providerID === "openai") {
    return {
      providerID,
      modelID,
      auth: await loadOpenAiAuth(),
      endpoint: "official"
    };
  }
  const provider = config?.provider?.[providerID];
  if (!provider) {
    throw new ProviderError(
      `Provider "${providerID}" is not configured in opencode config.`,
      `Add provider.${providerID}.options.baseURL and provider.${providerID}.options.apiKey, or use openai/<model>.`
    );
  }
  const baseURL = provider.options?.baseURL;
  if (!baseURL) {
    throw new ProviderError(
      `Provider "${providerID}" has no baseURL configured.`,
      `Set provider.${providerID}.options.baseURL to an OpenAI-compatible API base URL that supports /responses.`
    );
  }
  const key = providerApiKey(providerID, provider);
  if (!key) {
    throw new ProviderError(
      `Provider "${providerID}" has no API key configured.`,
      `Set provider.${providerID}.options.apiKey, provider.${providerID}.env, or ${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.`
    );
  }
  return {
    providerID,
    modelID,
    auth: { mode: "apikey", apiKey: key.apiKey, source: key.source },
    endpoint: "openai-compatible",
    responsesUrl: responsesUrl(baseURL)
  };
}

// src/index.ts
function createWebsearchTool(config, getOpencodeConfig) {
  return tool({
    description: "Search the web when the answer requires current, external, or source-backed information. Returns an answer with citations when the provider supplies them.",
    args: {
      query: z3.string().min(1).describe(
        "Specific question or search query. Include enough context to retrieve relevant sources."
      ),
      contextSize: searchContextSizeSchema.optional().describe(
        "Search context budget: low, medium, or high. Use high for broad or nuanced research."
      )
    },
    async execute(args, context) {
      const model = config.openai.model;
      let target;
      try {
        target = await resolveSearchTarget(model, config.provider, getOpencodeConfig());
      } catch (err) {
        if (err instanceof ProviderError) {
          return {
            title: `${config.toolName}: provider error`,
            output: `Error: ${err.message}

Hint: ${err.hint}`
          };
        }
        if (err instanceof AuthError) {
          return {
            title: `${config.toolName}: authentication error`,
            output: `Error: ${err.message}

Hint: ${err.hint}`
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
            contextSize: args.contextSize
          },
          { sessionId: context.sessionID },
          context.abort
        );
        const citationLines = result.citations.length > 0 ? result.citations.map((citation, index) => `[${index + 1}] ${citation.title}
    ${citation.url}`).join("\n") : "(no citations)";
        const output = result.citations.length > 0 ? `${result.answer}

---
Sources:
${citationLines}` : result.answer;
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
            citations: result.citations
          }
        };
      } catch (err) {
        if (err.name === "AbortError") throw err;
        if (err instanceof SearchApiError) {
          const hint = err.hint ? `

Hint: ${err.hint}` : "";
          return {
            title: `${config.toolName}: API error`,
            output: `Error: ${err.message}${hint}`,
            metadata: { statusCode: err.statusCode }
          };
        }
        throw err;
      }
    }
  });
}
var index_default = (async (_input, options) => {
  const config = parsePluginOptions(options);
  let opencodeConfig;
  return {
    async config(input) {
      opencodeConfig = input;
    },
    tool: {
      [config.toolName]: createWebsearchTool(config, () => opencodeConfig)
    }
  };
});
export {
  index_default as default
};

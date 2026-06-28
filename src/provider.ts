import type { Config } from "@opencode-ai/plugin";
import type { OpenAiAuth } from "./auth.js";
import { loadOpenAiAuth } from "./auth.js";

export type SearchTarget =
  | {
      providerID: "openai";
      modelID: string;
      auth: OpenAiAuth;
      endpoint: "official";
    }
  | {
      providerID: string;
      modelID: string;
      auth: { mode: "apikey"; apiKey: string; source: "provider-config" | "provider-env" };
      endpoint: "openai-compatible";
      responsesUrl: string;
    };

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function splitModel(
  model: string,
  defaultProvider: string,
): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: defaultProvider, modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function responsesUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}

function resolveEnvTemplate(value: string): string | null {
  const match = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return value;
  return process.env[match[1]] ?? null;
}

function providerApiKey(providerID: string, provider: NonNullable<Config["provider"]>[string]) {
  if (provider.options?.apiKey) {
    const apiKey = resolveEnvTemplate(provider.options.apiKey);
    if (apiKey) return { apiKey, source: "provider-config" as const };
  }

  for (const envName of provider.env ?? []) {
    const value = process.env[envName];
    if (value) return { apiKey: value, source: "provider-env" as const };
  }

  const envFallback = process.env[`${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
  if (envFallback) return { apiKey: envFallback, source: "provider-env" as const };
  return null;
}

export async function resolveSearchTarget(
  model: string,
  defaultProvider: string,
  config: Config | undefined,
): Promise<SearchTarget> {
  const { providerID, modelID } = splitModel(model, defaultProvider);
  if (!providerID || !modelID) {
    throw new ProviderError(
      `Invalid model "${model}".`,
      "Use provider/model format, for example `openai/gpt-5.5` or `custom_provider/gpt-5.5`.",
    );
  }

  if (providerID === "openai") {
    return {
      providerID,
      modelID,
      auth: await loadOpenAiAuth(),
      endpoint: "official",
    };
  }

  const provider = config?.provider?.[providerID];
  if (!provider) {
    throw new ProviderError(
      `Provider "${providerID}" is not configured in opencode config.`,
      `Add provider.${providerID}.options.baseURL and provider.${providerID}.options.apiKey, or use openai/<model>.`,
    );
  }

  const baseURL = provider.options?.baseURL;
  if (!baseURL) {
    throw new ProviderError(
      `Provider "${providerID}" has no baseURL configured.`,
      `Set provider.${providerID}.options.baseURL to an OpenAI-compatible API base URL that supports /responses.`,
    );
  }

  const key = providerApiKey(providerID, provider);
  if (!key) {
    throw new ProviderError(
      `Provider "${providerID}" has no API key configured.`,
      `Set provider.${providerID}.options.apiKey, provider.${providerID}.env, or ${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.`,
    );
  }

  return {
    providerID,
    modelID,
    auth: { mode: "apikey", apiKey: key.apiKey, source: key.source },
    endpoint: "openai-compatible",
    responsesUrl: responsesUrl(baseURL),
  };
}

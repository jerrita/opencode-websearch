import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type OpenAiAuth =
  | { mode: "apikey"; apiKey: string; source: "env" | "opencode" | "codex" }
  | {
      mode: "oauth";
      accessToken: string;
      accountId?: string;
      fedramp?: boolean;
      source: "opencode" | "codex";
    };

const opencodeAuthSchema = z
  .object({
    openai: z
      .union([
        z.object({ type: z.literal("api"), key: z.string() }).passthrough(),
        z
          .object({
            type: z.literal("oauth"),
            access: z.string(),
            refresh: z.string().optional(),
            expires: z.number().optional(),
            accountId: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

const codexTokensSchema = z
  .object({
    id_token: z.string().nullable().optional(),
    access_token: z.string().nullable().optional(),
    refresh_token: z.string().nullable().optional(),
    account_id: z.string().nullable().optional(),
  })
  .passthrough();

const codexAuthSchema = z
  .object({
    OPENAI_API_KEY: z.string().nullable().optional(),
    tokens: codexTokensSchema.nullable().optional(),
  })
  .passthrough();

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function opencodeAuthPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

function codexAuthPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadOpencodeAuth(): Promise<OpenAiAuth | null> {
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
    source: "opencode",
  };
}

async function loadCodexAuth(): Promise<OpenAiAuth | null> {
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
    accountId:
      parsed.tokens.account_id ?? (typeof claimAccountId === "string" ? claimAccountId : undefined),
    fedramp: claims.chatgpt_account_is_fedramp === true,
    source: "codex",
  };
}

export async function loadOpenAiAuth(): Promise<OpenAiAuth> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return { mode: "apikey", apiKey, source: "env" };
  }

  try {
    const opencodeAuth = await loadOpencodeAuth();
    if (opencodeAuth) return opencodeAuth;
  } catch (err) {
    throw new AuthError(
      `Failed to read opencode OpenAI auth: ${(err as Error).message}`,
      "Run `opencode auth login` again or remove the invalid opencode auth entry.",
    );
  }

  try {
    const codexAuth = await loadCodexAuth();
    if (codexAuth) return codexAuth;
  } catch (err) {
    throw new AuthError(
      `Failed to read Codex OpenAI auth: ${(err as Error).message}`,
      "Run `codex login` again or remove the invalid Codex auth file.",
    );
  }

  throw new AuthError(
    "No OpenAI credentials found.",
    "Run `opencode auth login`, run `codex login`, or set OPENAI_API_KEY.",
  );
}

export function buildOAuthHeaders(
  auth: Extract<OpenAiAuth, { mode: "oauth" }>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  if (auth.fedramp) headers["X-OpenAI-Fedramp"] = "true";
  return headers;
}

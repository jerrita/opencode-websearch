# opencode-websearch

OpenCode plugin that adds a configurable web search tool for OpenAI Responses-compatible providers.

```json
{
  "plugin": [
    [
      "opencode-websearch",
      {
        "provider": "openai",
        "toolName": "web_search",
        "openai": {
          "model": "openai/gpt-5.5",
          "contextSize": "medium"
        }
      }
    ]
  ]
}
```

The model value uses opencode's `provider/model` format. `openai/gpt-5.5` uses opencode's official OpenAI auth. A custom OpenAI-compatible provider can be used by pointing the model at that provider:

```json
{
  "provider": {
    "custom_provider": {
      "options": {
        "baseURL": "https://example.com/v1",
        "apiKey": "{env:CUSTOM_PROVIDER_API_KEY}"
      }
    }
  },
  "plugin": [
    [
      "opencode-websearch",
      {
        "openai": {
          "model": "custom_provider/gpt-5.5"
        }
      }
    ]
  ]
}
```

Authentication lookup order:

1. `OPENAI_API_KEY`
2. opencode auth at `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`
3. Codex auth at `${CODEX_HOME:-~/.codex}/auth.json`

When the provider is `openai`, the plugin calls `https://api.openai.com/v1/responses` for API-key auth or the Codex-compatible responses endpoint for OAuth auth. For any other provider, the plugin calls `${provider.options.baseURL}/responses` with the configured provider API key.

# Configuration reference

This page documents configuration that is read by the runtime in `src/`. Each
section names the source file that implements it, so the text can be checked
against the code. Settings files are layered as described in
[Architecture](ARCHITECTURE.md#settings-and-workspace-trust).

## Model providers

Source: `src/provider-registry.mjs`.

The runtime knows providers by name from one registry. Setup, the in-chat
`configure_provider` tool, `--fallback-model provider:model`, `oasis connect
--from-env`, local-server discovery (`oasis setup --auto`, `oasis doctor`) and
setup-preset inference all read it. The browser app in `app/core/` keeps its own
catalogue because it runs without Node.js.

Built-in providers:

| id | Protocol | Base URL | Key variables |
|---|---|---|---|
| `openai` | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `gemini` | openai-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `groq` | openai-compatible | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `deepseek` | openai-compatible | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `mistral` | openai-compatible | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `xai` | openai-compatible | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `moonshot` | openai-compatible | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `huggingface` | openai-compatible | `https://router.huggingface.co/v1` | `HF_TOKEN`, `HUGGINGFACE_API_KEY` |
| `together` | openai-compatible | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `fireworks` | openai-compatible | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `cerebras` | openai-compatible | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `nvidia` | openai-compatible | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `ollama` (local) | openai-compatible | `http://127.0.0.1:11434/v1` | `OLLAMA_API_KEY` (optional) |
| `lmstudio` (local) | openai-compatible | `http://127.0.0.1:1234/v1` | none |
| `llamacpp` (local) | openai-compatible | `http://127.0.0.1:8080/v1` | none |
| `jan` (local) | openai-compatible | `http://127.0.0.1:1337/v1` | none |
| `vllm` (local) | openai-compatible | `http://127.0.0.1:8000/v1` | `VLLM_API_KEY` (optional) |

Amazon Bedrock, Google Vertex AI and Microsoft Foundry are configured through
`src/cloud-providers.mjs`, not this table.

### Adding or re-pointing a provider

Add a `providers` object to your user settings (`settings.json` in the config
directory: `$OASIS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/oasis` or
`~/.config/oasis`, or `%APPDATA%\oasis` on Windows), a `--settings` file, or
managed policy:

```json
{
  "providers": {
    "acme": {
      "protocol": "openai-compatible",
      "baseURL": "https://llm.acme.internal/v1",
      "keyEnv": ["ACME_API_KEY"],
      "model": "acme-coder",
      "label": "Acme gateway"
    },
    "groq": { "baseURL": "https://groq-proxy.example/v1" }
  }
}
```

- `protocol` must be `openai-responses`, `openai-compatible` or `anthropic`.
- `catalog` (optional) names the [models.dev](https://models.dev) provider whose
  context limits, output limits and prices apply, for a gateway that serves
  another provider's models (for example `"catalog": "anthropic"`). Built-ins
  already carry theirs.
- `baseURL` must be `http:` or `https:`.
- An entry that overrides a built-in keeps the built-in's other fields.
- Ids are lowercase letters, digits, `-` and `_` (up to 40 characters).
- Invalid entries are ignored, so a typo cannot stop OASIS from starting.

A repository's own `.oasis/settings.json` cannot define providers, even in a
trusted workspace: a provider entry decides where an API key is sent.

The environment can re-point any provider without a settings file:
`OASIS_PROVIDER_<ID>_BASE_URL` and `OASIS_PROVIDER_<ID>_MODEL` (the id upper-cased,
other characters replaced by `_`). For fallbacks only,
`OASIS_FALLBACK_<ID>_BASE_URL` is also read.

### Fallback models

`--fallback-model` (and the `fallbackModel` setting) takes a comma-separated
list. `provider:model` uses that registry provider with its own key, so the main
key is never sent to another provider; a bare model runs on the current
provider. Hosted providers without a key in the environment are skipped; local
servers do not need one. Source: `src/fallback-chain.mjs`.

## Output token limit

Source: `maxOutputTokensFor` in `src/agent.mjs`.

1. `OASIS_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` or the
   `maxOutputTokens` config value, clamped to 1,024–128,000.
2. Otherwise the model's output limit from the models.dev catalog
   (`src/model-catalog.mjs`), capped at 32,000 and at a quarter of the model's
   context window.
3. Otherwise a name-pattern default: 8,192 for older models, 16,384 for
   GPT-4o/GPT-4 Turbo, 32,000 for recent families.

If a provider rejects the request as too large, the turn retries with the limit
parsed from the error.

## Search tools

Sources: `src/tools.mjs`, `src/power-tools.mjs`, `src/git-visible-files.mjs`.

- `glob_files` and `search_files` list files with `git ls-files` (honouring
  `.gitignore`) or, outside Git, a directory walk bounded at 250,000 entries.
  Patterns are matched while listing, so result caps count matches, not files
  seen.
- `search_files` runs ripgrep (`-F -i`, files up to 256 KB) when a ripgrep binary
  is available (bundled `@vscode/ripgrep`, `OASIS_RIPGREP_PATH`, or `rg` on
  `PATH`), and a JavaScript scan otherwise.
- `grep` accepts `pattern`, `path`, `glob`, `type`, `output_mode`
  (`content`, `files_with_matches`, `count`), `ignore_case`, `context`, `before`,
  `after`, `multiline`, `limit` and `offset`. It also accepts ripgrep-style names
  that models trained on other harnesses send: `-i`, `-C`, `-A`, `-B`,
  `head_limit`.

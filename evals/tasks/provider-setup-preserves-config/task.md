Fix provider setup defaults so reopening `oasis setup` does not silently replace the user's configured provider.

In `src/config.mjs`, export `getProviderSetupDefaults(saved)`. It must return `{ protocol, baseURL, model }` defaults using the saved configuration when valid. Recognized protocols must be preserved. If the saved protocol is missing or unsupported but the saved base URL is valid, infer the native Anthropic or OpenAI protocol when the host is recognized; otherwise use `openai-compatible` and preserve the custom URL. A fresh install must default to OpenAI Responses, its default base URL, and its default model. For an OpenAI-compatible endpoint with no saved URL or model, leave those values empty so the setup flow asks the user.

Update `src/cli.mjs` to use the helper before asking questions, show the resolved defaults in the prompts, and reuse the already-loaded saved configuration when handling API keys. Do not change credential isolation rules or the existing validation of protocol and base URL.

Add `test/provider-setup-defaults.test.mjs` covering fresh-install defaults, a saved Anthropic provider, a saved OpenAI-compatible custom endpoint, and an unsupported protocol paired with a valid custom URL.

The independent verifier runs the repository's Node test suite. Do not modify the evaluator or the verifier.

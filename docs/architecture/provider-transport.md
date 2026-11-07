# Provider transport architecture

OASIS separates **model-provider policy** from **provider wire formats**.

The agent runtime owns retry policy, fallback ordering, permission checks,
stream watchdogs, and session state. A provider transport owns only the
protocol-specific work needed to turn a normalized request into a provider
response.

## Contract

`src/model-transport.mjs` defines the initial stable interface:

- `normalizeTransportConfig(config)` validates and normalizes provider input.
- `transportEndpoint(config)` resolves the protocol-specific endpoint.
- `transportRequestBody(config)` serializes the message history.
- `transportReadStream(response, protocol, onDelta, onProgress)` normalizes
  streamed provider output.
- `defaultModelTransport` is the current implementation and preserves the
  existing OpenAI Responses, OpenAI-compatible, and Anthropic behavior.

## Boundaries

A transport must not:

- Retry requests.
- Choose fallback providers.
- Mutate files or execute commands.
- Make permission decisions.
- Own session state.

The runtime remains responsible for those concerns. This keeps provider
adapters small, testable, and replaceable.

## Current implementation

The default transport wraps the existing, production-tested request
serializers and stream parser. It preserves support for:

- OpenAI Responses API.
- OpenAI-compatible chat-completions endpoints.
- Anthropic Messages.
- Anthropic-compatible Bedrock, Vertex AI, and Microsoft Foundry routes.
- Streaming tool calls, reasoning output, image replay, and interrupted-stream
  detection.

## Future replacements

A future transport can implement the same interface for an SDK-backed provider,
a local inference runtime, or a sandboxed gateway. The agent runtime should not
need to change when a transport changes.

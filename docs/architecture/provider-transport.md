# Provider protocol boundaries

OASIS keeps provider policy separate from provider-specific wire formats.

The agent runtime owns model selection, retry policy, fallback ordering,
credentials, cancellation, stream watchdogs, usage accounting, and session
state. Protocol adapters own only message conversion and stream decoding.

## Active implementation

The production request/stream seams are:

- `src/provider-requests.mjs`: endpoint construction and message/tool
  serialization for OpenAI Chat Completions, OpenAI Responses, and Anthropic
  Messages.
- `src/provider-stream.mjs`: server-sent event framing, provider event
  decoding, tool-call assembly, reasoning metadata, usage merging, and
  interrupted-stream handling.
- `src/agent.mjs`: request lifecycle, provider-specific headers and options,
  retries, fallback, cancellation, and integration with the turn state.

These modules are exercised by the live agent. There is currently **no
standalone `ModelTransport` interface wired into the runtime**. An earlier
`src/model-transport.mjs` prototype was removed because it duplicated the
active serializers without owning the real request lifecycle.

## Boundaries

A protocol adapter must not:

- Retry requests or choose fallback providers.
- Make permission decisions or execute workspace tools.
- Own session state or usage/cost accounting.
- Receive workspace credentials unrelated to its configured provider.

The runtime remains responsible for these concerns. This keeps protocol
conversion independently testable without introducing an unused second
transport architecture.

## Supported protocol behavior

The active request and stream modules preserve:

- OpenAI Responses API.
- OpenAI-compatible Chat Completions endpoints.
- Anthropic Messages.
- Provider-specific reasoning/tool metadata replay.
- Image and tool-result replay.
- Streaming tool-call assembly, usage accounting, and interrupted-stream
  detection.

## Next extraction

A future `ProviderTransport` contract should be introduced only when the live
request path can use it end-to-end. That migration must preserve headers,
model-specific options, reasoning metadata, tool-call IDs, usage, timeout,
cancellation, retries, and fallback behavior. A serializer-only wrapper is not
a production transport abstraction.

---
name: api-development
description: Design and implement validated, authenticated APIs with clear error contracts and safe lifecycle handling.
---

# API development skill

1. Read the existing API conventions and call sites before adding routes, dependencies, or new abstractions.
2. Validate HTTP method, path parameters, request content type, body size, object shape, field types, and allowed values before performing side effects.
3. Use explicit authentication and authorization. Treat CORS and same-origin checks as defense-in-depth, not substitutes for authentication.
4. Return consistent status codes and bounded error messages; do not leak API keys, environment variables, stack traces, or internal filesystem details.
5. Bound concurrent work, request duration, output/event history, and resource cleanup. Make retries and duplicate submissions safe where practical.
6. Use parameterized/argv-based process execution rather than shell interpolation. Require approval for consequential side effects and explain what approval permits.
7. Test unauthenticated, malformed, oversized, cross-origin, duplicate, timeout, and error-path behavior using temporary resources and mocked external services.
8. Document the trust boundary, deployment assumptions, and any remaining rate-limit, transport-encryption, or sandbox limitations.
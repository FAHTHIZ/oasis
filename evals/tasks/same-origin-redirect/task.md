Implement the following behavior in the shared OASIS snapshot.

Task: Implement resolveRedirectTarget(baseUrl, location). Resolve relative or absolute redirect locations against baseUrl. Return a normalized URL string only when both URLs use HTTP(S), the target is same-origin as the base URL, and the target has no username or password. Return null for malformed URLs, cross-origin targets, unsupported protocols, or credentials.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

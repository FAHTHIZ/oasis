Create src/lib.mjs exporting validateBaseUrl(...) to solve this task: Accept only HTTP(S) URLs, allow HTTP only on loopback, reject credentials/query/fragments, strip trailing slashes, and provide an exact isLoopbackUrl helper.
The verifier runs existing repository checks and then validates the helper. Preserve the existing repository's safety guards.

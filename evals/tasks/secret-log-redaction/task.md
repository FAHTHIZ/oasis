Implement the following behavior in the shared OASIS snapshot.

Task: Implement redactSecrets(text). Return a string with Bearer credentials and values for case-insensitive api_key, api-key, token, password, secret, and authorization keys replaced by [REDACTED]. Support colon or equals separators and quoted or unquoted values. Preserve surrounding non-secret text.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

Implement the following behavior in the shared OASIS snapshot.

Task: Implement parseJsonBody(chunks, maxBytes = 16384). Parse UTF-8 JSON from an iterable of string or Buffer chunks while enforcing the limit incrementally. Return { statusCode: 200, body } for valid JSON, { statusCode: 400, error } for malformed JSON, and { statusCode: 413, error } as soon as total bytes exceed the limit. Count UTF-8 bytes, not JavaScript characters. Invalid or negative limits fall back to 16384.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

Implement the following behavior in the shared OASIS snapshot.

Task: Implement class TtlCache. Constructor options are { ttlMs = 1000, maxEntries = 100, now = Date.now }. Provide set(key, value) and get(key). Entries expire when now() - createdAt >= ttlMs. Updating a key refreshes its insertion order and timestamp. When capacity is exceeded, evict the oldest insertion. Keep the injected clock deterministic for tests.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

Implement the following behavior in the shared OASIS snapshot.

Task: Implement shouldRetryStatus(status, attempt, maxAttempts = 3). Return true only for transient HTTP codes 408, 425, 429, 500, 502, 503 and 504, and only when attempt is a positive integer less than maxAttempts. Attempts are 1-based. Invalid inputs, non-transient statuses, and the final allowed attempt return false.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

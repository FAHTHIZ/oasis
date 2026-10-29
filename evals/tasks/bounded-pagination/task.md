Implement the following behavior in the shared OASIS snapshot.

Task: Implement normalizePagination(input = {}). Normalize integer limit values to 1..100; use 20 when the value is malformed, non-integer, or unsafe. Normalize offset to a safe non-negative integer, otherwise 0. Accept integer numbers and trimmed base-10 integer strings, without accepting decimals or exponent notation. Return { limit, offset }.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

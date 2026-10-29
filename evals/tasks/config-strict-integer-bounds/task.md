Fix permissive integer parsing in OASIS configuration and add regression tests.

In `evals/snapshots/oasis-main/src/config.mjs`, the private `clampInteger` helper currently accepts partial numeric strings (for example, `"12junk"`) and truncates fractional numbers (for example, `4.5`). Change it to accept only safe integer numbers or strings containing a complete base-10 integer after trimming whitespace. Invalid, unsafe, fractional, exponent-form, and partially numeric values must use the provided fallback. Valid integers must still be clamped inclusively to the given minimum and maximum.

Add `test/config-bounds.test.mjs` with regression tests covering valid integer strings, trimming, lower and upper clamping, malformed strings, decimals, exponent notation, unsafe integers, and fallback values for both `maxSteps` and `maxCommandSeconds`.

Do not modify the evaluator or external verifier.

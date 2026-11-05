Create src/lib.mjs exporting boundedToolBatch(requested, maximum = 16) to solve this task: Default a non-numeric or absent batch size to maximum (16 by default). Clamp numeric sizes to 0..maximum while preserving explicit zero: -4 becomes 0 and 99 becomes 16.
The verifier runs existing repository checks and then validates the helper. Preserve the existing repository's safety guards.

Create src/lib.mjs exporting resolveRelative(...) to solve this task: Resolve a relative path below the workspace root and throw if it escapes via ../ or an absolute path. Use path.relative rather than string-prefix checks.
The verifier runs existing repository checks and then validates the helper. Preserve the existing repository's safety guards.

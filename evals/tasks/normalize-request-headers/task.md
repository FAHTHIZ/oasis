Implement the following behavior in the shared OASIS snapshot.

Task: Implement normalizeHeaderValue(headers, name). Support Web Headers objects and plain header records. Look up keys case-insensitively, trim string values, and return null when missing or when the selected value is not a string. For plain records, throw an Error when multiple keys differ only by case and match the requested name; never silently choose between ambiguous values.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

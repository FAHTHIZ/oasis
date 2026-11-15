Implement the following behavior in the shared OASIS snapshot.

Task: Implement normalizeArchivePath(entryName). Accept only non-empty strings and normalize safe relative archive paths to forward slashes. Reject NUL bytes, absolute POSIX paths, Windows drive paths, UNC paths, and any path containing a '..' segment. Reject entries that normalize to an empty path. Do not rely on string-prefix comparisons. Reject by throwing an Error. Put it in a new file src/lib.mjs as the named export normalizeArchivePath.

The independent verifier exercises the exported API directly. Do not modify the evaluator or verifier.

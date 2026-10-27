Fix sliceLines(text, offset, limit) so offset is 1-based and defaults to the first line. Clamp invalid or too-small values safely, cap limit at 2000 lines, and support both LF and CRLF input.

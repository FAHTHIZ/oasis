Fix isLoopbackUrl(raw) to parse the URL and match only exact loopback hostnames. Do not accept lookalike domains such as localhost.example or evil-127.0.0.1.test. Invalid URLs should return false.

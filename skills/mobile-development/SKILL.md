---
name: mobile-development
description: Build and troubleshoot mobile applications and mobile-device development environments safely.
---

# Mobile development skill

1. Inspect the existing framework, target platforms, package scripts, SDK requirements, and project conventions before changing architecture.
2. Distinguish browser/PWA behavior from native Android or iOS capabilities. Do not claim device APIs, background execution, local shell access, or offline behavior unless implemented and tested on the target.
3. For Android and Termux, verify the device architecture, Node/runtime support, storage permissions, and available package managers before suggesting installation steps. Give one terminal command at a time when the user is following steps interactively.
4. Prefer official SDKs, package managers, and documented APIs. Avoid remote shell scripts, broad permissions, and hard-coded secrets.
5. Design for narrow screens, touch targets, keyboard/IME behavior, reduced motion, accessible labels, and graceful network loss.
6. Keep device-only secrets out of browser storage, logs, screenshots, source control, and agent prompts unless essential.
7. Add tests for platform-independent logic and explicitly list the device checks that cannot be simulated in CI.
8. Never claim a mobile build or install succeeded without an actual build/install result on the target platform.
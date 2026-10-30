# OASIS chat-first redesign progress

This log follows the chat-first redesign brief. Existing runtime behavior, approval gates, local-only defaults, token handling, and DOM IDs are preserved while the interface is updated.

## Step 0 — Agent-page defects

- Removed the literal escaped newline before the Agent view's local-only notice.
- Changed the sidebar portal mark to the root-relative `/assets/oasis-mark.svg` path; the existing SVG artwork was valid and was not replaced.
- Updated the site-integrity check and browser regression assertions to require the corrected asset path.
- Rebased the work on the latest `main` revision, including the follow-up workflow-sandbox compatibility fixes.

## Step 1 — Visual foundation

- Added the brief's palette as shared CSS tokens: Night `#0B100C`, sidebar `#0D130E`, panel `#101811`, borders `#1C271F` / `#2B3B30`, text `#E8EFE9`, muted `#9BAA9F`, and lime `#9BFF55`.
- Replaced gradient washes on the main card surfaces with flat panels.
- Reserved lime for New chat, Send, and approval-allow actions; ordinary actions and status indicators use neutral or restrained success colors.
- Set local Inter and JetBrains Mono font stacks without remote font loading or new application dependencies.
- Added contrast-ratio assertions for muted, primary, and lime-button text.
- Added a CI-only Axe color-contrast scan of the Agent sidebar and view at `1280x800` and `390x844`.
- Added dedicated desktop and phone screenshots to the browser E2E workflow artifact. The browser job runs independently of core integrity tests so visual evidence is still collected if an unrelated engine test fails.

## Validation

- Source-level assertions cover the palette, flat surfaces, contrast ratios, asset path, Axe scan, and screenshot outputs.
- Current-head quality and browser/Axe workflows must complete before Step 1 is considered verified.
- The redesign PR remains draft pending review of the generated screenshots and full CI results.

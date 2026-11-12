---
name: design
description: Explore a UI as several self-contained HTML variants (artboards) under design/<name>/ so they can be compared side by side in the Preview panel, then build the chosen one.
---

# Design artboards

Use this when the user asks for a screen, page, component or visual direction and has not settled on one.

1. Pick a short kebab-case name for the exploration (for example `pricing-page`). Read the project's
   existing styles, fonts, colours and components first so the variants fit the product.
2. Write three variants (or the number the user asked for, at most six) as
   `design/<name>/a.html`, `design/<name>/b.html`, `design/<name>/c.html`, ...
   - Each file is self-contained: inline CSS, no network fonts or CDNs, no build step, realistic copy
     instead of lorem ipsum. Relative links to project assets are fine.
   - Make the variants genuinely different (layout, hierarchy, density or tone), not colour swaps.
   - Put a one-line `<!-- variant: ... -->` comment at the top describing the idea.
   - Each page must look right at 1280px wide and still be usable at 390px.
3. Open each file with the browser tool when it is available and check for overflow, clipped text
   and contrast problems; fix what you find.
4. Reply with one line per variant (file, idea, trade-off) and say they can be compared in the web
   app under Preview, Artboards. Do not change application code yet.
5. When the user picks a variant (or asks to combine parts), implement it in the real codebase with
   the project's framework and components, then remove the `design/<name>/` folder only if asked.

# OASIS brand guide

This document defines the public identity used by the OASIS repository, application, release artwork and project communications.

## Name and positioning

The public-facing product name is OASIS. Write it in uppercase in the wordmark, application name, repository title and user-facing copy. Do not append an OSS suffix to the product name.

The npm package identifier oasis-oss and Electron application identifier org.oasis.oss are technical namespaces. They are not the product name and must not be copied into logos, app titles, screenshots or promotional artwork.

**Tagline:** Code. Automate. Flourish.

**One-line description:** An open-source, model-agnostic coding-agent runtime and development workspace.

OASIS is the runtime and application layer around a configured model. Avoid implying that the harness replaces the model, guarantees a task outcome, or makes every model equivalent.

## The portal mark

The symbol is a layered portal: a rounded arch, a dark central opening and horizontal strata that descend from the threshold. The layers represent context, tools and agents working together in one focused workspace.

Use the maintained vector assets rather than redrawing the mark:

| Asset | Use |
|---|---|
| assets/oasis-icon.svg | Square app and repository icon. |
| assets/oasis-logo.svg | Horizontal portal mark, OASIS wordmark and tagline lockup. |
| assets/oasis-readme-hero.svg | Wide repository hero artwork with the portal grounded on a reflective floor. |
| app/icons/oasis-mark.svg | Compact mark for the installable browser app. |
| assets/icons/ and app/icons/ | Platform and PWA raster icon variants. |

Keep the central opening clear. Do not stretch, skew, crop through the arch, add an OSS suffix, or replace the portal with an unrelated generic AI symbol.

## The floor is part of the visual language

The portal should feel grounded, not suspended in empty space. Wide hero, splash and motion compositions should show a clear horizon or floor plane beneath it. A subtle reflection, perspective grid or controlled light spill can connect the portal to that surface.

The reflection should support the symbol rather than compete with it. Keep the floor darker than the portal, preserve enough negative space, and avoid turning every surface into a bright neon effect.

The repository hero is static artwork. It establishes the visual direction; it does not claim that a startup animation is currently implemented in the application.

## Color system

| Token | Hex | Role |
|---|---|---|
| Portal Lime | #7CFF5E | Primary accent and portal highlight. |
| Growth Green | #32E07A | Secondary accent and mid-tone gradient. |
| Deep Emerald | #0ED168 | Gradient depth and restrained active states. |
| Night | #0B0F0C | Primary background. |
| Elevated Night | #1A1F1B | Raised surfaces and panels. |
| Mist | #E6F5EA | Primary text on dark surfaces. |

Use the lime and greens as accents against dark neutral surfaces. Keep body text readable, preserve contrast, and do not communicate status through color alone.

## Typography

The wordmark asset uses a geometric sans-serif stack with generous letter spacing. Product interfaces should use the typography already defined by their own design tokens; do not introduce a new font dependency solely for repository artwork.

Use short headings, plain language and consistent capitalization. Use monospace only for commands, code, identifiers and terminal output.

## Motion language

A future startup sequence can follow the visual logic of the mark: a spark appears, the portal resolves, the horizontal layers align, the floor reflection settles, and the workspace becomes visible.

This is a design direction, not a claim that the animation exists in the current release. Keep motion short, purposeful, and respectful of reduced-motion settings.

## Repository presentation

- The GitHub repository and Releases page are the canonical project home.
- The Pages deployment serves the optional installable browser app; it is not a separate marketing-site requirement.
- Keep the README opening screen focused on the OASIS identity, one clear product description, useful badges and direct paths to install or learn more.
- Use real application screenshots for interface claims. Label conceptual artwork as brand artwork, not as a product screenshot.
- Keep badges factual and limited to checks, releases and licensing.
- Keep deeper implementation detail in maintained documentation rather than turning the README into a feature catalogue.

## Voice

Write with calm confidence. Prefer precise descriptions of shipped behaviour, explicit platform boundaries and reproducible instructions. Avoid inflated claims, unsupported comparisons, fake status indicators and promises that the software cannot verify.

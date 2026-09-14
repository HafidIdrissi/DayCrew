# DayCrew design: Iris & Slate

DayCrew uses a dark navigation rail and light work surfaces. The public site uses
the same palette, typography and controls. Pixel characters add personality while
forms, conversations and task information remain straightforward.

## Palette

| Purpose | Color |
| --- | --- |
| Primary action / Iris | `#6355D9` |
| Primary hover | `#5042BD` |
| Navigation / Slate | `#202330` |
| Main text | `#222635` |
| Supporting text | `#646C80` |
| Page background | `#F6F7FB` |
| Panel background | `#FFFFFF` |
| Selected surface | `#EFECFF` |
| Mint accent on dark surfaces | `#B6EDDB` |

The source of truth is `packages/design-tokens.css`. The `--blue` variables are
compatibility aliases to the new accent so existing components can use the same
palette. Do not add independent brand palettes to individual pages. Red and amber
remain reserved for errors and attention; mint is not used for text on white.

## Layout and interaction

- Desktop navigation stays visible. Mobile navigation scrolls horizontally rather
  than hiding destinations. Settings remains available beside the brand.
- Forms use visible labels, clear examples, 44px primary controls, focus rings and
  nearby error messages. Required values stay in the form after a failed save.
- Home leads with the Manager brief. Decisions and activity follow it.
- New teams offer a ready-made developer crew or a custom team starting with a Manager.
- Agent creation uses the conversation area. The preview becomes compact on
  smaller screens. Role cards provide editable starting instructions, without
  replacing a custom brief. Saving does not start work.
- Existing Auto engine settings and supported model selections are preserved.
  Model details and developer diagnostics use expandable sections.
- Task filters expose a Clear filters action. Engine state and simulated work
  continue to be explicitly labelled.
- Motion is disabled when the user prefers reduced motion. Keyboard users can
  skip navigation to the main content.

## Implementation

- `packages/web/src/styles.css`: existing component layout and component states.
- `packages/web/src/product-design.css`: application-wide layout and interactions.
- `packages/web/src/agent-form.css`: the dedicated agent form layout.
- `packages/site/src/site-design.css`: the public site layout.
- `packages/site/src/main.ts`: copyable commands and mobile navigation enhancement.

The site remains readable without JavaScript. Its existing Office screenshot is
labelled as predating this visual refresh until a new real capture is available.

## Verification

Run `pnpm check` (includes all package builds) and open both local interfaces:

```text
pnpm dev       → http://127.0.0.1:5173
pnpm dev:site  → http://127.0.0.1:4173
```

Visually inspect desktop and mobile widths, especially the agent editor, long
names, validation errors, task filters and installation blocks. Automated render
tests and successful builds do not replace this browser review.

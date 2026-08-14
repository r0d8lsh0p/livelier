# Livelier brand assets — drop zone

Everything the livelier.live site draws its visual identity from lives here.

## What to add

Put your brand standards document at `brand/BRAND.md` (any structure — palette,
type, logo usage, voice, do/don't). Put image files in `brand/assets/`.

Useful, in rough priority order:

| File | Notes |
|---|---|
| `assets/logo.svg` | Primary lockup (wordmark, or mark + wordmark). SVG preferred — it scales and inlines. |
| `assets/mark.svg` | Just the symbol, square-ish. Used for the favicon and small placements. |
| `assets/logo-mono.svg` | Single-colour version, if the primary is multi-colour. |
| `assets/og.png` | Social preview card, 1200×630. Can be generated from the above if you'd rather. |
| anything else | Illustrations, textures, patterns — drop them in and say what they're for. |

PNG is fine where SVG doesn't make sense (photography, raster illustration);
supply at 2× the intended display size.

## What the site does with them

- The mark becomes the favicon and the in-page brand element.
- Colours and type from `BRAND.md` replace any placeholder palette hard-coded
  in the site styles.
- Fonts are **self-hosted** — no Google Fonts or other CDN, so the page makes no
  third-party requests. If your brand type is a licensed webfont, add the
  `.woff2` files here and note the licence in `BRAND.md`.

## Conventions

- Lowercase, hyphenated filenames.
- Keep the source of truth here; the build copies/optimises into the bundle. Do
  not edit generated files under `site/public/`.
- No marks, colours, or typefaces borrowed from any client or platform the
  bridge talks to — Livelier reads as a neutral, independent project.

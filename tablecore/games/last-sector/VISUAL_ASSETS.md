# Last Sector Visual Assets v1

## Asset policy

All tactical map assets are lightweight SVG symbols in `games/last-sector/assets.svg` and are referenced through `assets.mjs`.

Player and TV share the same asset vocabulary but apply different scale, glow and composition rules.

## Ships

- `scout`: fast/light silhouette
- `transport`: broad carrier silhouette
- `warship`: heavy armed silhouette
- `tanker`: compact fuel carrier silhouette

## Sector objects

- planet
- station
- base
- asteroid
- pirate
- nebula
- signal
- accelerator
- teleport
- anomaly
- blackhole

## Runtime rules

- Use SVG symbols for crisp scaling and low payload.
- `currentColor` controls faction/semantic tinting.
- Do not embed game state into the asset itself.
- Do not use raster assets for map glyphs unless a browser profile proves a need.
- Presentation FX belong to `presentation.js`, not the asset registry.

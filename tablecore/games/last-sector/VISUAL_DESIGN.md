# Last Sector Visual Design v1

## Direction

Dark tactical sci-fi HUD with restrained neon accents. The UI should feel like a ship's command console rather than a conventional web dashboard.

## Player UI

- Map is the primary surface.
- Other ships remain visible as compact tactical markers.
- Player ship gets the strongest contrast and localized HUD.
- Actions are grouped in a dense two-column tactical control block.
- Event log stays visible but visually secondary.
- Hexes use color and lighting to distinguish terrain without heavy images.

## TV UI

- Map is the dominant visual.
- Player roster and event feed frame the action.
- Presentation events drive flashes and effects; state events update the tactical map.
- Scanline and glow effects are CSS-only and limited to low-cost decorative layers.
- The layout targets 16:9 first, then scales down for smaller displays.

## Performance rules

- Retained DOM only.
- One delegated click handler for the map.
- FrameScheduler batches state updates.
- Presentation events do not trigger map rebuilds.
- No per-cell timers or observers.
- No per-frame layout reads.
- Assets should stay lightweight; move large art to canvas/WebGL only after browser profiling proves DOM insufficient.


## Player mobile-first v1.21

- Primary map surface; bottom action dock; icon-only actions on phones.
- Status is compact and expandable into a bottom sheet.
- No hover dependency. Touch targets are 44px or larger.
- Object glyphs are CSS/text-only semantic markers; no heavy image assets on the map.
- TV retains separate cinematic composition and operator roster.

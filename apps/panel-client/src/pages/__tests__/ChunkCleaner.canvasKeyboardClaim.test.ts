import { describe, it, expect } from 'vitest'
import en from '../../locales/en/chunkCleaner.json'

// bug-hunt-2026-08-26: god named the same defect class as moderationBanUser
// (196e057) on a different surface -- the UI claims something the system
// cannot do. Investigated ChunkCleaner.tsx's chunk-selection canvas:
//
//   <canvas ... role="img" aria-label={t("canvas.ariaLabel")} tabIndex={0}
//     onMouseDown={...} onMouseMove={...} onMouseUp={...} onTouchStart={...}
//     ... />  (no onKeyDown anywhere on the element)
//
// tabIndex={0} makes the canvas a real, focusable tab stop -- a keyboard or
// screen-reader user tabbing through the page lands on it. Its aria-label
// read "Chunk map -- select areas to clean up", an action-shaped phrase, on
// an element with ZERO keyboard handling: no onKeyDown, and no key ever
// reaches selection logic (the actual area-selection gesture only exists in
// the mouse/touch handlers). The only real keyboard support on this page is
// a WINDOW-level listener for Escape/Delete/1/2 (clear selection, delete
// selected chunks, switch tool) -- useful, but none of it can ever CREATE a
// selection, which is the core action the label promised. This is exactly
// "a focusable element that leads nowhere": the dead end here is structural
// (tabIndex + a real handler set that never includes keyboard), not a line
// of prose claiming a specific shortcut -- ChunkCleaner's own Help panel
// text ("Click or drag to select") never lied, only the canvas's own focus
// affordance did.
//
// Checked WorldMap.tsx too (in scope, same task): its canvas ALSO has
// tabIndex={0} + role="img", but its aria-label ("Use arrow keys to pan,
// plus/minus to zoom") matches a REAL onKeyDown handler that does exactly
// that (verified: ArrowUp/Down/Left/Right pan, +/- zoom, Escape dismiss).
// WorldMap's mouse-only pick-a-point actions (the right-click context menu)
// are never claimed to be keyboard-accessible anywhere in its copy or aria
// labels, so there is no false claim to correct there -- no fix, no test
// needed on that file for this task.
//
// Fix here (deliberately NOT a real keyboard selection path -- that is a
// feature decision, reported to god rather than built): removed
// tabIndex={0} from ChunkCleaner's canvas so it no longer offers a focus
// stop it cannot honour, and corrected the aria-label to state plainly that
// selecting/deleting areas requires a mouse or touchscreen. A full render
// test was not attempted: ChunkCleaner has zero existing test coverage,
// mounting the canvas requires clearing a save-selection -> scan -> chunks
// loaded gate plus a ResizeObserver-driven canvasSize before the <canvas>
// element exists in the DOM at all, and jsdom's canvas 2D context is a
// further unknown -- the same category of cost/risk already judged not
// worth it for a Radix Select interaction earlier tonight. This pins the
// corrected copy directly instead.

describe('ChunkCleaner -- the chunk-selection canvas no longer claims keyboard support it cannot deliver', () => {
  it('states plainly that selecting areas requires a mouse or touchscreen', () => {
    expect(en.canvas.ariaLabel).toMatch(/mouse or touchscreen/i)
    expect(en.canvas.ariaLabel).toMatch(/not keyboard-operable/i)
  })

  it('no longer phrases the label as an action the viewer can just perform', () => {
    // The old copy ("select areas to clean up") read as an instruction with
    // no stated means -- exactly what a focusable-but-dead element implies.
    expect(en.canvas.ariaLabel).not.toBe('Chunk map — select areas to clean up')
  })
})

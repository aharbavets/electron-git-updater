# Repository icon — what was chosen and what to fall back to

The installed icon is `.repoicon.svg` in the repository root.
Everything in this folder is the design source it came from, kept so that changing a shade or reverting is a copy rather than a redesign.

## Chosen: `b-ccw10-ry68.svg`

An atom whose orbit is the update arrow.
A tilted elliptical orbit (`rx 9`, `ry 6.8`, rotated −30°) broken by a 54° gap at the lower left, its free end carrying a chevron arrowhead aimed along the curve's own tangent and then turned 10° anticlockwise from it.
A nucleus at the centre and three electrons drawn as beads, each with a tile-coloured halo so the orbit reads as passing behind them rather than through them.

```bash
cp assets/icons/b-ccw10-ry68.svg .repoicon.svg
```

## Runner-up, kept deliberately: `reload-e3-big.svg`

The same idea on a **circular** orbit, built on Tabler's `reload` glyph, whose arrowhead is a right-angle bracket sitting outside the circle.

⭐ **It is the better choice if the icon ever needs to survive smaller sizes.**
Its head is two straight segments, which hold their shape at 16px, while a chevron aimed along a tangent softens into a thickening there.
The chosen icon was preferred for its movement at large sizes, not for legibility in a list — so if the list is ever what matters most, this is the one to switch to.

```bash
cp assets/icons/reload-e3-big.svg .repoicon.svg
```

## The decisions behind both, so they are not re-litigated

**The tile is `#DB2777` at a corner radius of 22.46% (`rx="230"` on a 1024 canvas).**
The radius is a house proportion kept fixed across icons, so ones made months apart still look like a family.

The colour was chosen by measurement rather than by eye, against **two** backgrounds:

| candidate | white glyph | vs a light list | vs `#1e1f22` |
| --- | --- | --- | --- |
| indigo `#4F46E5` | 6.29 | 6.29 | **2.62** ✗ |
| violet `#7C3AED` | 5.70 | 5.70 | **2.89** ✗ |
| fuchsia `#A21CAF` | 6.32 | 6.32 | **2.61** ✗ |
| **rose `#DB2777`** | **4.60** | **4.60** | **3.59** ✓ |

The dark list is what ruled out every richer candidate — they all look best on white and vanish on JetBrains' dark welcome screen.
`#DB2777` was also chosen to stand apart from the blues and greens already in use nearby: in a list the colour does more to tell projects apart than the drawing does.

**The artwork fills 76% of the tile**, fitted by measuring the ink's alpha bounding box and iterating, because the stroke scales with the glyph and throws off a single-pass measurement.

## What was tried and rejected, with the reason

Keeping these saves repeating the experiments; every one of them looked fine until it was rendered at 16px.

- **The classic crossed-orbit atom** (`atom.svg`) — unreadable at 16px while beautiful at 96, and an arrowhead added to it disappears into the orbit crossing.
- **A horizontal orbit with a central nucleus** (`orbit-plain.svg`) — reads unmistakably as an **eye**. Tilting it is what fixed that.
- **A solid triangular arrowhead** (`tri-m`, `tri-l`, `tri-xl`) — reads as a funnel or a megaphone where it meets the line.
- **A short chevron head** (`gap-at-tip-0`, and the `contact-sheet-arrow.png` series) — at stroke width 2.3 a chevron of 2.6–3.4 units is barely longer than the stroke is thick, so it reads as a lump. Lengthening it, not widening it, is what made it an arrow.
- **Gaps at 135° and 315° on a flat ellipse** (`gap-135`, `gap-315`) — both read as the letters `Q` and `2`. A fuller ellipse (`ry 6.8`) removed that.
- **Turning the head too far** (`ccw34-e3`) — the whole figure becomes a clock hand pointing at one o'clock.

⚠️ In SVG the y axis points down, so turning a head **anticlockwise on screen means subtracting** from the angle. The sign is the opposite of the intuition.

## The contact sheets

Every judgement above was made from these, rendered at 16–240px on white **and** on `#1e1f22`; a dark panel is not optional, because the failure that matters is invisible on white.

`contact-sheet.png` · `contact-sheet-electrons.png` · `contact-sheet-fitted.png` · `contact-sheet-arrow.png` · `contact-sheet-arrow2.png` · `contact-sheet-gap.png` · `contact-sheet-gap2.png` · `contact-sheet-reload.png` · `contact-sheet-shortlist.png` · `contact-sheet-ccw.png` · `contact-sheet-ccw10-bigger.png` · `contact-sheet-vs.png`

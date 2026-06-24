# Apps

## Apps-Wide Design System

This design system applies to apps under `apps/`. App-specific `CLAUDE.md` files may extend these rules with domain semantics, but should keep the shared foundations intact unless there is a clear product reason to diverge.

### Product Posture

Apps in this repository should feel like focused work tools: quiet, dense, predictable, and built for repeated use. Prefer scan efficiency and stable layout over decorative presentation.

Use:

- Clear hierarchy through spacing, typography, and alignment.
- Restrained surfaces and borders.
- Stable dimensions for repeated controls, rows, boards, and fixed-format UI.
- Familiar controls for familiar interactions.

Avoid:

- Marketing-style hero layouts inside tools.
- Decorative blobs, ornamental gradients, and background effects.
- One-off font sizes, control heights, shadows, or colors.
- Nested cards or card-like page sections where a simple full-width region or dense list is enough.

### Typography

Use the repository app font stack unless an app has a strong reason to do otherwise:

```css
Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Shared type scale:

| Token | Size | Line Height | Use |
| --- | ---: | ---: | --- |
| `display-title` | 16px | 1.25 | compact page, modal, and section titles |
| `body` | 13px | 1.45 | readable body copy |
| `ui` | 12px | 1.25-1.35 | buttons, inputs, navigation rows, dense labels |
| `meta` | 11px | 1.2-1.35 | timestamps, counts, secondary controls |
| `kicker` | 10px | 1 | badges, uppercase category labels |
| `micro` | 9px | 1 | very dense structural labels |
| `code` | 11-12px | 1.45 | raw payloads, logs, code-like content |

Rules:

- Do not scale font size with viewport width.
- Keep letter spacing at `0` for normal text.
- Uppercase metadata may use `letter-spacing: 0.05em`.
- Inputs must set an explicit `font-size`; do not let input typography drift
  from surrounding container inheritance.
- Text must fit inside its control or row without overlapping nearby content.

### Spacing

Use a compact 2px/4px-derived spacing scale:

| Token | Value | Use |
| --- | ---: | --- |
| `space-1` | 2px | segmented separators, tiny gaps |
| `space-2` | 4px | compact row gaps |
| `space-3` | 6px | icon/text gaps, compact button padding |
| `space-4` | 8px | row gaps, compact panel padding |
| `space-5` | 10px | dense card and toolbar padding |
| `space-6` | 12px | panel padding, section gaps |
| `space-7` | 14px | command/header horizontal padding |
| `space-8` | 18px | larger inter-section gaps |
| `space-9` | 24px | viewport-edge padding and major insets |

Rules:

- Dense tools should prefer compact vertical rhythm.
- Preserve readable horizontal padding even when list or grid cells use edge-to-edge backgrounds.
- Do not enlarge a control by adding arbitrary padding when a named control height would solve alignment.

### Shape

Shared radius scale:

| Token | Radius | Use |
| --- | ---: | --- |
| `radius-small` | 4px | badges and small status tags |
| `radius-control` | 6px | buttons, inputs, mini controls |
| `radius-row` | 7px | hoverable dense result rows |
| `radius-panel` | 8px | real cards, detail windows, modals |
| `radius-pill` | 999px | search fields, segmented controls, toolbar pills |

Rules:

- Use cards for repeated items, modals, and genuinely framed tools.
- Do not put cards inside cards.
- Page sections should be full-width bands or unframed layouts, not floating decorative cards.

### Color

Shared primitives should be neutral and restrained:

| Token | Use |
| --- | --- |
| `bg` | app background |
| `panel` | primary panels and controls |
| `panel-soft` | subtle secondary panel background |
| `panel-strong` | hover/current row background |
| `text` | primary text |
| `muted` | secondary text |
| `faint` | disabled or tertiary text |
| `border` | default borders |
| `border-strong` | hover and emphasis borders |
| `accent` | active controls, focus, current item |
| `accent-soft` | selected or pressed background |
| `danger` | destructive/error foreground |
| `warning` | warning foreground |

Rules:

- Use semantic colors for meaning, not decoration.
- Error backgrounds should be used sparingly; prefer icon plus foreground color
  in dense navigational surfaces.
- Selection and focus must have sufficient contrast and must not depend on
  color alone when the element has important state.

### Controls

Shared control sizing:

| Token | Value | Use |
| --- | ---: | --- |
| `control-height` | 32px | default buttons and inputs |
| `control-height-compact` | 28px | compact navigation buttons |
| `segmented-height` | 30px | segmented control buttons |
| `icon-size` | 16px | toolbar icons |
| `search-icon-size` | 15px | search field icon when visually lighter |

Rules:

- Default command buttons and inputs use `ui` typography.
- Icon buttons should use a familiar icon when available and expose an
  accessible label.
- Segmented controls should keep a stable height and should not resize when
  badges, icons, or status markers appear nearby.
- Search input fields should align with the same control-height system as the
  toolbar or panel they belong to.

### Motion And Layout Stability

Rules:

- Use short transitions, usually 140-220ms.
- Animate opacity, transform, or bounded height only when the surrounding layout
  has a mechanism to stay correct.
- If an animation changes layout around fixed overlays, popups, or virtualized
  canvases, the app must remeasure during and after the transition.
- Hover, selected, loading, and search states must not resize fixed-format
  controls, timeline blocks, rows, or grid cells.

### Validation Expectations

For frontend changes:

- Verify at a normal desktop viewport and at any domain-critical large viewport.
- Check that text does not overlap or overflow controls.
- Check that focus, selected, error, and search states preserve layout.
- Add focused browser validation when the change affects navigation, search,
  fixed overlays, virtualized layouts, or cross-view state.

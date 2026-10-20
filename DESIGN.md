# Prompter design context: Vocal, Quiet Narration

Vocal is the selected art direction, not a product rename. The reader should become visually quiet while the controller remains legible and recoverable. Manuscript identity, narration state, follow state, manual repositioning, and controller ownership remain the existing application's responsibilities.

## Runtime tokens

- Controller ground `#f1d3db`, paper `#fff7f2`, ink/primary `#641a34`, muted `#7b4a5e`, border `#cba2b1`, selection `#f1f49a`.
- Focus `#354db8` with a 3px visible outline. Recoverable warning `#fff0cf` / `#744300`; error `#ad2e3d`; complete `#e6f1e6` / `#295a45`.
- Reader ground `#2c202c`, main text `#f6edf0`, surrounding prose `#e0cedb`, prior prose `#c7b4c5`, band edge `#e2cf9e`, quiet controls `#443141` / `#745a70`.
- Desktop fonts: unmodified Vocal-package DM Sans 400/500/600 and Bricolage Grotesque 700/800 WOFF2, with their OFL notices. Tablet currently falls back to platform sans faces because no matching native font files are present and the task terminal has no network access.
- Reader default: DM Sans 32px / 1.65, ~870px measure, 38% reading band. The band has thin static edges and no filled highlight by default.
- Controller touch target minimum 44px; asymmetrical 14px/22px corners make buttons and panels recognizable without reducing contrast or click area.
- Active controller values use the primary burgundy ink on paper surfaces; summary disclosures, tablet appearance, and advanced-mode controls use the same paper, border, and focus tokens as neighboring controls.
- The reader toolbar adapts to the reader pane's measured width (which changes when the controller is visible), wrapping into two or three rows at 900px and 560px pane widths. The manuscript viewport begins after the toolbar's observed rendered height, so a wrap or resize does not cover text or change the configured reading-band percentage.
- The pinned controller header is opaque and fills the scrollport's top edge, preventing moving section content from showing through gaps around the pinned surface while preserving keyboard and pointer access.

## Ownership and mapping

| Visual surface | Current runtime owner | Design adapter |
| --- | --- | --- |
| Desktop controller, manuscript setup, recovery | `src/components/ControlPanel.tsx` | Existing features retained; Vocal tokens and sculpted paper sections in `src/styles.css` |
| Desktop narration status and controls | `src/components/NarrationBar.tsx` | Adds selected-manuscript name and approval identity; keeps start, pause, level, warning, Prep and controls actions |
| Desktop reading/follow | `src/components/PrompterView.tsx` | Quiet reader colors and band; existing scroll/follow calculations remain authoritative |
| Android connection/settings/diagnostics | `android/.../ui/AppNavigation.kt` | Shared Compose palette and corner shapes |
| Android reader and manual recovery | `android/.../ui/prompter/PrompterScreen.kt` | Quiet reader defaults and static band edges; protocol/runtime settings and movement behavior remain authoritative |

## Decisions

- The desktop reader footer exposes previous/next sentence, Resync, and text-size adjustment only when the controller is hidden. It calls existing recovery/settings actions and does not add navigation state.
- Approved manuscript status is shown alongside the selected project in the reader header; unapproved text is labeled plainly and points to Manuscript Prep.
- Tablet retains its existing top status, diagnostics/settings access, and microphone action. Styling does not alter pairing, controller lease, reconnect, or audio behavior.
- The design candidate is a separate package identity and output path. It is for review and is not installed into booth use.

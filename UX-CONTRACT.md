# Prompter Vocal interaction contract

This design pass changes presentation and adds one compact reader-only control surface. The following existing behavior remains the contract.

| User intent | Existing action/state owner | Vocal surface |
| --- | --- | --- |
| Choose or approve the manuscript | Manuscript Prep and `App` selection callback | Current manuscript title and approval hash are visible in the reader header |
| Start, pause/resume, stop | `NarrationBar` and provider/session coordinator | Persistent, labeled controls with visible disabled/focus states |
| Follow recognized narration | `PrompterView` and `SessionCoordinator` | Same 38% reading band; static warm edge, no animation/decorative fill |
| Recover manually | Existing sentence/paragraph stepping, Resync, manual scroll and reacquisition | Controller retains full recovery actions; hidden-controller footer surfaces sentence stepping and Resync |
| Hide/reopen controller | Existing `controlsVisible` state and persisted preference | Toggle remains available in the narration bar |
| Tablet owns narration | Existing connection/controller lease and protocol state | Tablet status, reconnect, microphone, settings and diagnostics stay available |
| Reconnection and recovery | Existing `MainViewModel`, connection and movement controllers | Palette and component shapes only; no transport or authority contract changes |

The footer is intentionally limited to currently supported calls. It does not introduce chapter navigation, transport, a new pairing flow, or a new manuscript/project model. Button focus is visible, controls have 44px minimum targets, and essential labels are not hover-only.

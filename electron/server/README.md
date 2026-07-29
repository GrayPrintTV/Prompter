# Electron tablet server foundation

`PrompterServer` is the lifecycle and routing boundary. It is disabled at every launch and listens only after the tray command enables it. The first implementation selects a concrete RFC1918 IPv4 address and stable port (43127, configurable with `PROMPTER_SERVER_PORT`); it never binds to `0.0.0.0` and never creates firewall rules.

The supporting services isolate DNS-SD advertisement, pairing approval and one-time codes, credential persistence, connection challenge authentication, renderer session synchronization, and bounded PCM16 audio ingress. JSON control frames use the shared envelope. Each audio metadata message is followed by one binary PCM16 little-endian frame. The queue has no overlap, produces approximately two-second WAV chunks, and retains the existing Local Whisper CPU/int8 `base.en` configuration.

## Tablet runtime settings

While Tablet Mode is active, Windows is the source of truth for the tablet palette, typography, reading-band fraction, and native-follow policy. The effective complete `runtimeSettings` object is included in every session snapshot and pushed independently when a desktop display setting changes; a settings update never changes the manuscript revision, controller lease, or accepted reading position. Colors, typography, reading-band location, smoothness, speed, and follow enablement are immediate client-rendering changes. The existing lookahead value is immediate server-processing configuration for the next coordinator decision. Protocol code, native code, dependencies, and permissions still require a rebuilt client.

Typography uses presentation units instead of copying desktop CSS units: Windows `fontSizePx` is calibrated to Android `fontSizeSp` (`0.9 * px + 4`, clamped), line height stays a multiplier, and `textWidthCh` is sent as a normalized `contentWidthFraction` (0.52?0.94). Android retains the newest semantic movement target during a settings relayout, waits for the target paragraph's new `TextLayoutResult`, then realigns that same line to the reading band. A tablet can opt into local, persisted display-only typography/width/band values; those never leave Android or affect alignment.

## Session authority

- Desktop microphone/provider active: renderer coordinator is authoritative; a tablet controller lease is denied.
- Tablet microphone lease active: Electron main's coordinator is authoritative. Coordinator diagnostics and manuscript consistency still project to the renderer, but tablet-originated accepted positions are marked diagnostic-only there. Semantic movement is sent to Android, which owns visual scrolling.
- Manual mode/no active transcript source: renderer synchronization is authoritative.
- Provider or lease changes: only one transcript source is permitted. Acquiring a tablet lease enters Tablet Mode and hides the main window; release, explicit disconnect, server shutdown, or disconnect timeout returns to Desktop Mode without starting a desktop microphone. The final accepted position is projected once on exit.

## Tablet narration starts

Controller leases and WebSocket connections are not narration sessions. A fresh tablet audio stream starts a new narration session at the manuscript beginning by default, arms a startup alignment anchor in that beginning region, and clears transcript context. The tray can explicitly choose Resume from a preserved same-manuscript position or use the current Windows view before the stream starts. A reconnect inside the controller grace period keeps the active narration session; a deliberate stop or lease release ends it. New manuscript content always starts from the beginning.

Renderer synchronization remains available while the listener is disabled, is revisioned and deduplicated, and does not replace desktop localStorage. Pixel positions and visual line numbers never cross the protocol boundary.

## Security scope

Credentials are encrypted with Electron `safeStorage` when available. A clearly diagnosed base64 plaintext fallback is used when OS encryption is unavailable. Credentials, proofs, raw audio, and complete manuscripts are not written to diagnostics. This trusted-LAN prototype uses authenticated cleartext WebSocket. Certificate-pinned WSS is mandatory before broader distribution.

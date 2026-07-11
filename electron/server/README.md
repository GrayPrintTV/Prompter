# Electron tablet server foundation

`PrompterServer` is the lifecycle and routing boundary. It is disabled at every launch and listens only after the tray command enables it. The first implementation selects a concrete RFC1918 IPv4 address and stable port (43127, configurable with `PROMPTER_SERVER_PORT`); it never binds to `0.0.0.0` and never creates firewall rules.

The supporting services isolate DNS-SD advertisement, pairing approval and one-time codes, credential persistence, connection challenge authentication, renderer session synchronization, and bounded PCM16 audio ingress. JSON control frames use the shared envelope. Each audio metadata message is followed by one binary PCM16 little-endian frame. The queue has no overlap, produces approximately two-second WAV chunks, and retains the existing Local Whisper CPU/int8 `base.en` configuration.

## Session authority

- Desktop microphone/provider active: renderer coordinator is authoritative; a tablet controller lease is denied.
- Tablet microphone lease active: Electron main's coordinator is authoritative; accepted state is projected back to the renderer, which continues to own visual scrolling.
- Manual mode/no active transcript source: renderer synchronization is authoritative.
- Provider or lease changes: only one transcript source is permitted; releasing the tablet lease returns authority to renderer synchronization.

Renderer synchronization remains available while the listener is disabled, is revisioned and deduplicated, and does not replace desktop localStorage. Pixel positions and visual line numbers never cross the protocol boundary.

## Security scope

Credentials are encrypted with Electron `safeStorage` when available. A clearly diagnosed base64 plaintext fallback is used when OS encryption is unavailable. Credentials, proofs, raw audio, and complete manuscripts are not written to diagnostics. This trusted-LAN prototype uses authenticated cleartext WebSocket. Certificate-pinned WSS is mandatory before broader distribution.

# Prompter shared protocol

This directory is the language-neutral boundary between the authoritative Windows Prompter session and future native clients. JSON Schema is the source of truth. Electron main now validates these shapes for the manually enabled trusted-LAN prototype.

## Versioning

- `protocolMajor` changes when a message or field changes incompatibly. A major mismatch rejects a connection.
- `protocolMinor` covers backward-compatible additions. Peers with the same major may communicate when they support every received message type and its required fields.
- Additive fields should be optional. Unknown optional fields may be ignored.
- `sessionRevision` and `manuscriptRevision` describe authoritative state changes and are independent of the transport protocol version.
- Sequence numbers are monotonically increasing within a future connection. They detect stale, duplicated, or missing application messages; they do not replace WebSocket ordering.

The future Android implementation may generate or implement `kotlinx.serialization` models from these schemas. Rendered lines and pixel positions are intentionally absent from authoritative movement messages because native layout differs from the Windows renderer.

## Schema map

- `common.schema.json`: shared identifiers, revisions, offsets, positions, and enums.
- `envelope.schema.json`: common message envelope.
- `session-snapshot.schema.json`: complete authoritative recovery state.
- `transcript-event.schema.json`: provider-neutral transcript evidence and resulting position.
- `movement-event.schema.json`: semantic movement anchors.
- `audio-control.schema.json`: stream start/stop/gap control and metadata associated with PCM16 binary frames.
- `pairing-auth.schema.json`: pairing and connection-challenge authentication payloads.
- `runtime-settings.schema.json`: complete Windows-authoritative tablet palette, layout, native follow behavior, and server-alignment display configuration. It is carried in snapshots and live `runtimeSettings` messages without changing manuscript or lease revisions.
- `manual-reposition.schema.json`: authenticated tablet reading-band anchor used to rebase the shared coordinator after an intentional native scroll.

The prototype uses explicit Windows approval, random per-device credentials, challenge authentication on connection establishment, and ordinary WebSocket ordering plus sequence/revision checks. It deliberately uses cleartext `ws` only on a trusted private LAN. Certificate-pinned WSS is required before broader distribution. Custom per-frame cryptography remains explicitly outside this protocol.

# Prompter shared protocol

This directory is the language-neutral boundary between the authoritative Windows Prompter session and future native clients. JSON Schema is the source of truth. The schemas describe messages only; this phase does not provide a transport, listener, pairing implementation, or cryptography.

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
- `audio-control.schema.json`: stream start/stop/gap control and reserved binary-frame metadata.
- `pairing-auth.schema.json`: message-shape placeholders only. No authentication is implemented here.

Before broader distribution, the future transport is expected to use explicit Windows approval, random per-device credentials, challenge authentication on connection establishment, ordinary WebSocket ordering plus sequence/revision checks, and certificate-pinned WSS. Custom per-frame cryptography is explicitly outside this protocol foundation.


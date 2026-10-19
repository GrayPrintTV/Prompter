# Manuscript Prep IPC Contract

## Purpose

This document defines the local IPC boundary between Electron main and the
Manuscript Prep worker. Its initial transport is UTF-8 JSON Lines over worker
stdin/stdout: exactly one JSON object per line, with no logging or prose on
stdout.

The renderer never communicates with the worker directly. It uses typed,
allowlisted preload functions exposed by Electron main.

## Authority

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| Renderer | Requests actions, renders typed state/progress, collects password in a secure field | Launch worker, pass arbitrary paths, read/write project files |
| Preload | Exposes narrow typed APIs/status subscriptions | Expose generic IPC/filesystem access |
| Electron main / Prep service | Validates input, resolves safe paths, supervises/cancels/restarts worker, updates project references | Trust renderer paths; retain passwords |
| Prep worker | Extracts, OCRs, validates, and writes draft/approval artifacts from prevalidated inputs | Trust a path blindly; update active manuscript |
| Project-data service | Updates `project.json` after verified approval | Accept unverified worker output |

Electron main is the filesystem authority. The worker receives canonical IDs and
narrow prevalidated paths, then independently rejects traversal, symlink escape,
source/output overlap, and ambiguous overwrite. Nothing in this protocol grants
arbitrary filesystem access.

## Framing and versioning

Initial protocol version: `1`.

Every request includes `protocolVersion: 1`. Incompatible semantic/schema
changes require a new version; additive optional fields may be added to version
1. Electron must validate the worker startup handshake before dispatching work.

All IDs are opaque generated strings: `requestId`, `projectId`, `sourceId`,
`draftId`, and `approvedId`. They are never filenames, paths, or text.

Worker startup:

~~~json
{"kind":"hello","protocolVersion":1,"worker":{"name":"manuscript-prep-worker","version":"0.1.0","capabilities":["inspect","extract","get_draft","apply_review_change","approve","cancel"]}}
~~~

Request:

~~~json
{"kind":"request","protocolVersion":1,"requestId":"req_01J...","operation":"inspect","payload":{}}
~~~

Success:

~~~json
{"kind":"result","protocolVersion":1,"requestId":"req_01J...","ok":true,"payload":{}}
~~~

Error:

~~~json
{"kind":"result","protocolVersion":1,"requestId":"req_01J...","ok":false,"error":{"code":"SOURCE_UNREADABLE","message":"The source file could not be read.","retryable":false,"details":{"format":"pdf"}}}
~~~

A request may emit zero or more progress events, followed by exactly one
terminal result:

~~~json
{"kind":"progress","protocolVersion":1,"requestId":"req_01J...","stage":"ocr","message":"Recognizing page 18 of 343","completed":18,"total":343,"cancellable":true}
~~~

Worker-initiated `status` events are lifecycle-only and contain no manuscript
content, paths, or secrets. Invalid JSON, missing envelope fields, unknown
message kind, or prose on stdout are protocol violations.

## Common rules

### Revisions and idempotency

A draft has a positive integer `revision`. Every mutation includes
`expectedRevision`. Mismatch returns `DRAFT_REVISION_CONFLICT` and makes no
change; conflicts are never merged silently.

Each logical mutation includes a generated `idempotencyKey`. Retrying the same
key with identical material input returns the original terminal result. Reusing
the key with different material input returns `IDEMPOTENCY_KEY_REUSED`.

### Source reference

Electron resolves the selected source to a canonical, prevalidated reference:

~~~json
{"sourceRef":{"sourceId":"src_01J...","canonicalPath":"worker-only canonical path","displayName":"corrupt-text.pdf","formatHint":"pdf","expectedSha256":"lowercase hex","sizeBytes":1234567,"archivedCopy":false}}
~~~

`canonicalPath` is never returned to the renderer, written to provenance, or
logged. The worker verifies the observed hash against `expectedSha256` before
extraction. The renderer never sends a raw path to the worker.

Electron and worker enforce configured limits for input bytes, pages, render
pixels, OCR pages, text blocks, edit size, and preview bytes. Breach returns
`INPUT_LIMIT_EXCEEDED` with the limit name.

### Diagnostics

~~~json
{"id":"diag_01J...","severity":"review_required","category":"ocr_low_confidence","message":"OCR confidence is low on page 18.","source":{"page":18,"blockIds":["block_01J..."]},"suggestedAction":"Review the page and generated text."}
~~~

Severity is `blocking`, `review_required`, `check`, or `information`. The UI may
change presentation but not blocking meaning.

### Review operations

Review changes are structured operations stored in `review.patch.json`, not line
diffs. They record base revision and stable target IDs.

~~~json
{"operationId":"op_01J...","kind":"replace_block_text","blockId":"block_01J...","text":"Corrected prepared text.","reason":"user_edit"}
~~~

| Kind | Required fields | Effect |
| --- | --- | --- |
| `replace_block_text` | `blockId`, `text` | Replaces text for one block. |
| `set_block_inclusion` | `blockId`, `included` | Includes/excludes a reviewed block. |
| `apply_repetition_rule` | `rule`, `scope` | Applies reviewed repeated-content rule. |
| `resolve_diagnostic` | `diagnosticId`, `resolution` | Records required user decision. |
| `restore_generated_text` | `blockId` | Removes user replacement. |

No review operation changes the author source.

## Operations

### Inspect

Identifies true file type, access state, structure counts, and proposed route
without creating a draft or approval.

~~~json
{"projectId":"project_01J...","sourceRef":{},"options":{"password":"in-memory only; omit unless required"}}
~~~

The password exists only on the live main-to-worker request. It never appears
in persisted requests, results, progress, errors, logs, crash reports, or
telemetry.

Success includes observed format/source identity; access state (`readable`,
`password_required`, `access_denied`, or `unsupported_protection`); structural
counts; proposed route (`direct`, `ocr`, `mixed`, `not_available`); diagnostics;
and whether extraction may proceed. `password_required` is a successful outcome
that causes the renderer to show the dedicated local unlock prompt.

### Extract

Creates a draft extraction.

~~~json
{"projectId":"project_01J...","sourceRef":{},"draftId":"draft_01J...","idempotencyKey":"extract_01J...","options":{"password":"in-memory only; optional","requestedRoute":"auto"}}
~~~

`requestedRoute` is `auto`, `direct`, or `ocr`. It is a preference, not an
override of safety. Success returns draft ID, initial revision, state
(`ready`, `review_required`, or `incomplete`), route summary, counts, and
diagnostics. It returns no source paths or passwords.

### Get draft and list drafts

Get draft retrieves typed review data:

~~~json
{"projectId":"project_01J...","draftId":"draft_01J...","include":{"blocks":true,"diagnostics":true,"reviewOperations":true}}
~~~

Large block arrays use an opaque `cursor`. Results include current revision.
List drafts returns summaries only: ID, display name, creation time, state,
route, revision, and resumability.

### Render page

Renders one bounded, temporary source preview for review:

~~~json
{"projectId":"project_01J...","draftId":"draft_01J...","page":18,"render":{"maxWidth":1600,"maxHeight":2200,"highlight":{"blockIds":["block_01J..."]}}}
~~~

It returns an Electron-approved opaque preview reference or bounded transfer
descriptor, page number, route, and optional geometry - never a filesystem path.
Preview cache is never source of truth.

### Apply review change

~~~json
{"projectId":"project_01J...","draftId":"draft_01J...","expectedRevision":4,"idempotencyKey":"review_01J...","operation":{}}
~~~

Success returns new revision, changed summaries, and approval eligibility.
Revision conflict makes no change.

### Approve

Approve is the only operation that creates `approved/<approved-id>/`.

~~~json
{"projectId":"project_01J...","draftId":"draft_01J...","expectedRevision":7,"approvedId":"approved_01J...","idempotencyKey":"approve_01J...","approval":{"acknowledgeNonBlockingWarnings":true}}
~~~

It refuses incomplete drafts, changed sources, unresolved required diagnostics,
or failed serialization/hash validation.

Serialization is exact: UTF-8 without BOM, Unicode NFC, LF (`\n`) line endings,
and exactly one final LF for a non-empty manuscript. No reader-import cleanup
may change an approved artifact after this operation.

The worker:

1. Validates IDs, revision, eligibility, and idempotency.
2. Rechecks source identity when accessible.
3. Deterministically serializes reviewed blocks.
4. Writes `manuscript.txt` and `provenance.json` to a newly created sibling
   temporary directory.
5. Computes/verifies hashes and closes files as safely supported.
6. Atomically renames directory to `approved/<approved-id>/`.
7. Returns approved ID, text SHA-256, size, provenance summary, and timestamp.

Electron verifies the result and updates `project.json` only after worker
success. Retry after success returns the same identity. An existing different
package returns `APPROVAL_ALREADY_EXISTS` and is never overwritten.

### Cancel

~~~json
{"projectId":"project_01J...","targetRequestId":"req_01J..."}
~~~

Cancellation is cooperative. The target request ends with `CANCELLED`. Valid
partial drafts are returned as `incomplete` and cannot be approved. Cancellation
does not undo an already completed atomic approval. Electron may terminate and
restart an unresponsive worker after its grace period, returning
`WORKER_TERMINATED` for in-flight requests.

## Error codes

| Code | Meaning | Retryable |
| --- | --- | --- |
| `UNSUPPORTED_PROTOCOL_VERSION` | Main and worker cannot safely communicate. | No |
| `INVALID_REQUEST` | Schema/field validation failed. | No |
| `INPUT_LIMIT_EXCEEDED` | Configured resource/safety limit exceeded. | Sometimes |
| `SOURCE_NOT_FOUND` / `SOURCE_UNREADABLE` | Source missing or unreadable. | Sometimes |
| `SOURCE_CHANGED` | Source hash changed. | Yes |
| `PASSWORD_REQUIRED` / `INVALID_PASSWORD` | Standard password needed or failed. | Yes |
| `UNSUPPORTED_PROTECTION` | DRM/certificate protection cannot be processed. | No |
| `UNSUPPORTED_FORMAT` | Feature/format unsupported. | No |
| `EXTRACTION_FAILED` / `OCR_FAILED` | Required processing did not complete. | Sometimes |
| `DRAFT_NOT_FOUND` / `DRAFT_INCOMPLETE` | Draft missing or cannot be approved. | Sometimes |
| `DRAFT_REVISION_CONFLICT` | Mutation targeted obsolete revision. | Yes |
| `REVIEW_REQUIRED` | Required review decision is unresolved. | Yes |
| `UNSAFE_PATH` | Path or symlink validation failed. | No |
| `IDEMPOTENCY_KEY_REUSED` | Same key used for distinct request. | No |
| `APPROVAL_ALREADY_EXISTS` / `APPROVAL_FAILED` | Approval conflict or safe-completion failure. | Sometimes |
| `CANCELLED` / `WORKER_TERMINATED` | Active work stopped. | Yes |
| `INTERNAL_ERROR` | Unexpected redacted fault. | Sometimes |

## Privacy and testing

Stdout is protocol only. Main logs request ID, operation, elapsed time, outcome,
worker version, and bounded error code - never passwords, manuscript contents,
raw paths, or full payloads. Worker stderr is bounded and redacted. Provenance
records password use only as a boolean.

Electron service and worker share JSONL fixtures for: handshake mismatch,
malformed frames, TXT happy path, duplicate idempotent mutations, stale
revision, cancellation/incomplete draft, source hash change, password
redaction, unsafe path rejection, approval atomicity, exact encoding/NFC/LF/
final-newline output, and no secrets/content/paths in logging fixtures.
Corrupt-text, scanned, and mixed-PDF fixtures follow with those adapters.

## First milestone

Implement the envelope, versioning, IDs, cancellation, revision, idempotency,
redaction, and atomic approval rules from the first line of code. TXT-only v1
requires only Inspect, Extract, Get draft, Apply review change, Approve, and
Cancel. Render page and List drafts remain absent from worker capabilities until
page sources and history UI ship.

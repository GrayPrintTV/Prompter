# Manuscript Prep - Product Requirements

## 1. Purpose

Manuscript Prep converts author-supplied manuscript files into a clean, reviewable UTF-8 plain-text manuscript for audiobook proofing.

Its purpose is to reduce author friction: an author should normally be able to send the format they already have, while the narrator receives a trustworthy `manuscript.txt` suitable for Proofer.

Manuscript Prep is an input-preparation tool. It does not transcribe audio, detect narration errors, alter Proofer detection rules, or edit the author’s original file.

## 2. Primary User Workflow

1. The narrator selects or drops an author-supplied manuscript.
2. Manuscript Prep identifies the file type and attempts the safest available extraction method.
3. It reports extraction quality and any warnings.
4. The narrator reviews flagged material, making only deliberate corrections to the generated text.
5. The narrator approves and saves an immutable UTF-8 `manuscript.txt`.
6. Proofer uses that approved text as its authoritative manuscript input.

The original supplied file and the approved text remain separately preserved and identifiable.

## 3. Supported Inputs

### Required

- Plain text: `.txt`, `.text`
- Word: `.docx`
- EPUB: `.epub`
- Rich text: `.rtf`
- HTML: `.html`, `.htm`
- PDF: text-based, image-based, and password-protected PDFs when the user supplies a valid password

### Nice to Have

- OpenDocument text: `.odt`
- Legacy Word: `.doc` through a clearly identified conversion path

### Out of Scope for v1

- Reconstructing a manuscript from audiobook audio
- Editing the author’s original file
- Silently correcting grammar, spelling, punctuation, or wording
- Circumventing password, certificate, DRM, or access controls

## 4. Extraction Strategy

Manuscript Prep must select and disclose the extraction method.

| Input condition | Preferred handling |
| --- | --- |
| TXT | Validate encoding and normalize line endings only. |
| DOCX/EPUB/RTF/HTML | Extract structured text while preserving paragraph and chapter boundaries. |
| Healthy text PDF | Extract the embedded text layer. |
| PDF whose text layer is missing, corrupt, or implausible | Render pages and use OCR; label the result provisional until approved. |
| Image-only/scanned PDF | OCR rendered pages; surface lower-confidence pages and words. |
| Password-protected standard PDF | Prompt locally for the password, unlock only for the current session, then use the applicable extraction route. |
| DRM/certificate-protected or otherwise unreadable document | Stop with a clear explanation and request a readable source or authorized access. |

The tool must not assume that a visually readable PDF has usable embedded text. The `corrupt-text PDF` example is a required regression: it renders normally but its font Unicode mapping produces gibberish during normal text extraction.

## 5. Quality Gates and Warnings

Before approval, the tool must evaluate extraction quality and show a concise report.

### Required checks

- File opens successfully and page/chapter count is known where applicable.
- Text is not empty or overwhelmingly non-linguistic.
- Character encoding and Unicode normalization are valid.
- Paragraph breaks and chapter boundaries are retained where recoverable.
- Obvious page headers, footers, and page numbers are identified.
- Line-end hyphenation is detected rather than blindly joined.
- Repeated boilerplate is detected.
- Tables, footnotes/endnotes, captions, and image-only pages are flagged.
- PDF embedded-text output is compared against render/OCR samples when it appears corrupt.
- OCR confidence and page-level uncertainty are recorded when OCR is used.

### Warning philosophy

Warnings must be actionable and specific, such as:

> Embedded PDF text is unusable on pages 7-343. OCR was used. Review flagged names and hyphenated line endings before approval.

The tool should never silently present a dubious extraction as authoritative.

## 6. Review and Approval

The review surface should make the minimum useful review easy:

- Original-page or source preview beside generated text when feasible.
- A navigable list of warnings and low-confidence regions.
- Search for names, unusual words, and chapter headings.
- Clear indication of whether text came from direct extraction or OCR.
- Editable generated text, with deliberate user edits tracked separately from automatic extraction.
- An explicit **Approve manuscript for Proofer** action.

Approval creates a new immutable text artifact. It must not overwrite the original author file.

## 7. Output Contract

### Required output

- `manuscript.txt`
  - UTF-8
  - Plain text
  - Stable normalized line endings
  - No hidden formatting, fonts, images, or PDF layout objects

### Required provenance record

The approved output must record:

- Original filename, format, size, and SHA-256
- Original source location or user-selected reference
- Extraction method and tool version
- Whether a password was used (never the password itself)
- OCR engine/version and confidence summary, if used
- All warnings present at approval
- User edits, or at minimum that edits occurred
- Approved `manuscript.txt` SHA-256, size, and approval timestamp

The provenance record should be machine-readable JSON and remain adjacent to the approved text outside Git.

## 8. Security and Privacy

- Passwords are entered locally and used only in memory for the active import session.
- Passwords, decrypted originals, manuscript contents, author data, and user paths must never be committed to Git.
- The tool must not send manuscripts to a cloud service by default.
- OCR and extraction should run locally by default.
- Original inputs are read-only; all outputs go to a separate user-approved package directory.
- The tool must reject unsafe output paths, traversal, symlink escapes, and accidental overwrite of an original source.

## 9. Integration with Proofer

- Proofer continues to accept only approved UTF-8 plain-text manuscripts.
- Manuscript Prep is a separate module/client, not detector logic.
- Proofer job creation records the approved text identity and, when available, the Manuscript Prep provenance identity.
- Changing an approved manuscript produces a new identity; previously completed proof jobs remain linked to the earlier text.
- No transcription, alignment, tiering, marker geometry, or error-filter policy belongs in Manuscript Prep.

## 10. Acceptance Criteria for v1

1. Clean DOCX, EPUB, and TXT inputs produce usable UTF-8 plain text with preserved paragraph boundaries.
2. A healthy text PDF is extracted without OCR and clearly reports that route.
3. The `corrupt-text PDF` PDF is identified as having unusable embedded text and is routed to OCR rather than accepted as gibberish.
4. A scanned/image-only PDF is OCRed with page-level confidence warnings.
5. A standard password-protected PDF can be processed after the narrator enters the password locally; the password is absent from logs, artifacts, and source control.
6. An unreadable or DRM/certificate-protected file stops with a clear request for authorized access or another source.
7. The original file remains byte-for-byte unchanged.
8. Approval produces `manuscript.txt` plus provenance, each with verified SHA-256 identities.
9. Proofer can consume the approved output without any detector change.
10. The interface makes it clear when the result is direct extraction, OCR-derived, or still awaiting approval.

## 11. Open Design Decisions

- Initial platform: standalone Windows tool, a panel within Audition, or a shared cross-platform component with thin clients.
- OCR engine choice and model packaging.
- Whether review edits are stored as a patch/diff, revision history, or only a signed approval record.
- How aggressively to remove front matter, end matter, headers, and page numbers by default.
- Whether to support author-supplied pronunciation notes as a separate linked artifact.
- Retention and cleanup policy for original manuscripts and extracted work packages.

## 12. Non-Goals / Guardrails

Manuscript Prep must not become a hidden "make the text look plausible" machine. If extraction is uncertain, it should say so, show the evidence, and let the narrator approve a deliberate result. The goal is less author friction and safer Proofer inputs, not automatic editorial rewriting.

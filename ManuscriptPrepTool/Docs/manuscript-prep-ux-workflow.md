# Manuscript Prep UX Workflow

## Purpose

This document defines the user-facing workflow for Manuscript Prep inside
Prompter. It covers screen states, decisions, language, and safety behavior for
turning an author-supplied file into an approved narration/proof manuscript.

It complements the product requirements and architecture documents. It does not
define the worker protocol or renderer implementation.

## UX principles

1. **The usual path is short.** A healthy file should feel like import
   preflight, not a document-conversion application.
2. **Confidence is visible.** The user always knows whether the text is direct
   extraction, OCR-derived, mixed, draft, approved, or superseded.
3. **Nothing uncertain is quietly promoted.** Warnings explain what happened,
   where it happened, and the most useful next action.
4. **The original stays untouched.** The workflow never offers to edit an
   author-supplied source file.
5. **Approval is a deliberate handoff.** The wording makes clear that the
   approved text is the version used for narration and future proofing.
6. **Expert tools appear only when needed.** Normal DOCX/EPUB/TXT imports do
   not begin in a complex review mode; problematic PDFs can expand into one.
7. **Work is recoverable.** A cancelled or interrupted import remains visibly
   incomplete, never ambiguous or silently discarded.

## Vocabulary and status language

Use these terms consistently in the interface:

| Term | Meaning |
| --- | --- |
| **Source file** | The author-supplied document. It is read-only. |
| **Draft extraction** | Generated review text not yet approved for narration or Proofer. |
| **Direct extraction** | Text read from a usable document/text layer without OCR. |
| **OCR-derived** | Text recognized from rendered page images. |
| **Mixed extraction** | A document assembled from direct extraction and OCR by page/block. |
| **Review required** | Warnings or uncertainty need attention before approval. |
| **Ready to approve** | Extraction passed the required checks; approval is still explicit. |
| **Approved manuscript** | Immutable plain-text artifact suitable for narration and Proofer. |
| **Superseded** | A former approved manuscript retained for history after another was approved. |

Avoid calling a draft “the manuscript” without its qualifier. Never call a
direct extraction “verified” until approval has happened.

## Entry points and navigation

Manuscript Prep is a first-class Prompter workspace. It can be entered by:

- **Import manuscript** from the main Prompter workflow;
- a Manuscript Prep workspace/tab for the current book project;
- reopening an existing draft or approved manuscript from project history;
- selecting **Prepare a revised source** when an approved manuscript already
  exists.

The workspace header always shows the book/project name, current source
filename when present, and one status badge:

- gray: **No manuscript prepared**
- blue: **Draft extraction**
- amber: **Review required**
- green outline: **Ready to approve**
- solid green: **Approved**
- gray with history icon: **Superseded**
- red: **Import failed** or **Needs attention**

The reader must not imply that a draft is active narration text. Before reader
integration ships, the header may say **Approved for future reader/Proofer use**
rather than suggesting automatic loading.

## Primary flows

### 1. Normal import

This is the default for a clean TXT, DOCX, EPUB, RTF, or HTML file.

1. The narrator selects or drops a source file.
2. Prompter displays a compact import progress surface:
   **Inspecting _filename_…**
3. The app identifies the real file type and begins extraction:
   **Preparing text…**
4. On success, the result opens in a compact summary state:

   - route badge: **Direct extraction**
   - a short report, for example:
     **214 pages / 42 chapters detected. Paragraph boundaries preserved.**
   - warning count, if any
   - primary action: **Review and approve**
   - secondary action: **View extraction details**

5. If there are no blocking or high-severity warnings, the main action may be:
   **Approve manuscript for narration and Proofer**.

A successful normal import should require only a quick glance and one explicit
approval action. It must not force page preview or a warning panel open.

### 2. Review-required import

This is used for extraction with actionable warnings, including retained headers,
line-end hyphenation, tables/notes, missing chapter boundaries, and low
confidence regions.

The workspace uses three coordinated regions:

| Region | Contents | Behavior |
| --- | --- | --- |
| Left sidebar | Source structure and warning list | Filter by severity/type; clicking a result focuses the source and text. |
| Center | Generated, editable review text | Shows block boundaries only when useful; supports search and direct edits. |
| Right panel | Source evidence | Shows source page/preview or document location, route, and confidence. |

A persistent top bar states the current condition, such as:

> Review required: OCR was used on pages 7–343. Check flagged names and line-end hyphenation before approval.

The bar has **Review warnings** and **Show details** actions; it should not hide
the source of doubt behind a generic “conversion completed” message.

### 3. Corrupt or image-based PDF

The import flow must disclose both the condition and route change:

> The PDF opens normally, but its embedded text is unreadable on pages 7–343. Prompter used local OCR for those pages.

Display **Mixed extraction** or **OCR-derived**, not **Direct extraction**.
The review workspace opens automatically with the warning list focused on the
affected page range. The user can read and edit the generated text, compare it
to the page preview, search for names, and move among warnings.

The UI must not expose internal terms such as “CMap failure” unless included in
an expandable technical detail.

### 4. Password-protected PDF

After inspection determines that a standard PDF password is needed, show a
small, local-only password prompt:

- Title: **Unlock PDF**
- Body: **Enter the password supplied for this document. It is used only for
  this import and is not saved.**
- Secure password field
- Actions: **Cancel** and **Unlock and continue**

On a failure:

> That password did not unlock the PDF. Check it and try again.

Do not show the password in error text, history, notifications, or any review
metadata. Cancel returns the source to **Not imported**; it does not create a
draft.

### 5. Unreadable or access-controlled source

For DRM, certificate protection, unsupported access control, or a source that
cannot be read, stop before extraction:

> Prompter cannot read this document with the access provided. Ask the author
> for a readable copy or authorized access, then import it again.

Offer **Choose another file** and **Copy details**. Do not imply that there is
a workaround in the product, and never offer to bypass protection.

### 6. Cancellation, interruption, and recovery

During a long operation, show current stage, page/chapter progress when known,
and **Cancel import**.

Cancellation wording:

> Import cancelled. The source file was not changed.

If a valid partial draft exists, offer **Keep incomplete draft** and **Discard
incomplete draft**. The default should preserve it, marked **Incomplete - not
eligible for approval**. On worker interruption:

> Preparation stopped unexpectedly. Any completed draft is saved as incomplete;
> it has not been approved.

Offer **Resume/retry**, **Start again**, and **View details** as appropriate.
A retry creates a new attempt/revision rather than silently overwriting an
existing completed draft.

## Review interactions

### Warning list

Warnings are grouped by severity and type, with count and affected range:

- **Needs review**: source text could be missing, OCR is uncertain, extraction
  appears corrupt, or an edit/decision is required.
- **Check**: headers, footers, hyphenation, notes, captions, or structured
  content may need a decision.
- **Information**: route, page count, normalization, and non-blocking details.

The exact warning must name the scope, not merely the category:

> Repeated page header detected on pages 12–287. It is still included in the
> draft text.

Each warning provides relevant actions: **Go to text**, **View source**, and
where safe **Review suggested removal**. It never offers an unexplained
one-click deletion.

### Source and text linkage

Selecting a warning, search match, or block scrolls both the editable text and
the source preview to the linked location. For OCR, the right panel may show a
highlighted page region and confidence. If no precise region is available, show
the page and state **Exact position unavailable**.

Search supports names, unusual words, and chapter headings. Results identify
whether matches are in generated text, a warning description, or source
structure.

### Editing

Edits apply to generated draft text only. The first edit in a session makes the
distinction explicit:

> You are editing the prepared draft, not the author’s original file. Your
> changes will be recorded with this approval.

The review surface supports standard text editing, undo/redo, and an
**Edited** marker on changed blocks. It must not advertise grammar correction,
rewriting, or automatic “fix all” behavior.

Re-extraction is an explicit action. Before it runs, warn that the current
draft revision will remain in history but review edits may not apply cleanly to
the new extraction.

### Headers, footers, and boilerplate

When repeated content is detected, show the original text, scope, and proposed
rule:

> “NIGHT'S REDEMPTION” appears at the top of 276 pages.
> Proposed action: exclude this repeated page header from the prepared draft.

Actions are **Apply to this draft**, **Keep included**, and **Review pages**.
Applying a rule becomes a recorded review operation that can be undone before
approval.

Front matter and end matter receive the same proposed/confirm model. They are
never removed merely because the tool considers them non-narrative.

## Approval

The primary action is always labeled:

**Approve manuscript for narration and Proofer**

Approval is available only when the draft is complete and all blocking warnings
have a recorded resolution. Non-blocking checks may remain visible and are
recorded in provenance.

The confirmation summarizes what will be frozen:

- source filename and source hash;
- extraction route: direct, OCR-derived, or mixed;
- number of user edits and review decisions;
- remaining non-blocking warnings;
- explicit statement: **The original source file will not be changed.**

Actions are **Approve manuscript** and **Return to review**.

On success, replace the draft status with:

> Approved manuscript created. This version is immutable and identified by its
> text hash.

Show **Open approved text**, **View provenance**, and **Prepare a revised
source**. The default primary action is **Done**, not automatic reader
replacement.

## Existing approvals and revisions

When an approved manuscript exists and the narrator imports another source or
revises the current source, clarify the historical effect:

> Preparing a revised manuscript will not change the approved version already
> linked to earlier work. A new approval will create a separate version.

The project history lists approved versions with timestamp, source filename,
route, text hash, and whether each is active or superseded. It must not display
passwords, full private source paths, or manuscript text snippets as metadata.

Until reader selection is implemented, no approval claims to replace the active
reader manuscript. When it is implemented, switching requires an explicit
**Use this approved manuscript in Prompter** action and should state that the
current reader session will load the selected approved version.

## Source copy and retention choices

The default import reads the selected source in place. If the product later
offers archival copying, make it an explicit choice:

- **Keep source where it is** (default)
- **Save a read-only source copy with this project**

Explain that the original is never edited either way. Preview pages, OCR
working files, and draft history need a later dedicated retention UI; until
then, show their location/size only in technical details and do not silently
delete them.

## Accessibility and keyboard behavior

- Every state, warning, and route badge has text in addition to color.
- The warning list, text editor, page preview, and approval controls are fully
  reachable by keyboard.
- Focus moves to the result summary after import, to the selected text block
  after choosing a warning, and to the confirmation heading when approval is
  opened.
- Page previews provide page number and extraction-route text equivalents.
- Long OCR imports announce progress without stealing focus from an edit in
  progress.

## Initial implementation boundary

The first milestone implements only the smallest useful subset:

- workspace entry and status header;
- TXT source selection, inspection, direct extraction, basic diagnostics, and
  editable draft text;
- incomplete/failed states;
- explicit, atomic approval producing `manuscript.txt` and `provenance.json`;
- project history sufficient to distinguish draft from approved output.

Page preview, DOCX/EPUB/RTF/HTML, PDF/OCR review, password flow, and reader
selection are designed above so their later additions preserve these states and
terms rather than replacing the UX model.

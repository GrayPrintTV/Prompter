import { useEffect, useState } from 'react';
import type { PrepDraft, PrepProjectSummary } from '../../shared/manuscriptPrep/types';

export function ManuscriptPrepWorkspace({ onClose, onSelect }: { onClose(): void; onSelect(value: Awaited<ReturnType<NonNullable<typeof window.prompterApi>['readPrepApproved']>>): void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PrepDraft | null>(null);
  const [summary, setSummary] = useState<PrepProjectSummary | null>(null);
  const [status, setStatus] = useState<'idle' | 'draft' | 'ready' | 'review' | 'approved' | 'failed' | 'incomplete'>('idle');
  const [message, setMessage] = useState('No manuscript prepared');

  const refreshSummary = () => projectId ? window.prompterApi?.getPrepProjectSummary(projectId).then(setSummary).catch(() => undefined) : undefined;
  useEffect(() => { void window.prompterApi?.getPrepActiveProjectId().then(setProjectId).catch(() => setStatus('failed')); }, []);
  useEffect(() => { void refreshSummary(); }, [projectId]);

  async function importText() {
    setMessage('Inspecting source file…'); setStatus('idle');
    try {
      if (!projectId) throw new Error('Preparing the local project…');
      const result = await window.prompterApi?.importPrepTxt(projectId);
      if (!result) { setMessage('Import cancelled. The source file was not changed.'); return; }
      if (!result.extracted?.ok) {
        const extractionError = result.extracted && 'error' in result.extracted ? result.extracted.error.message : undefined;
        const inspectionError = !result.inspected.ok ? result.inspected.error.message : undefined;
        setStatus('failed'); setMessage(extractionError ?? inspectionError ?? 'Import failed.'); return;
      }
      const value = result.extracted.payload as { draftId: string };
      const loaded = await window.prompterApi?.getPrepDraft(projectId, value.draftId);
      if (!loaded?.ok) throw new Error(loaded?.error.message ?? 'Draft could not be loaded.');
      const requiresReview = loaded.payload.diagnostics.some((item) => item.severity === 'review_required' && !loaded.payload.resolvedDiagnostics?.[item.id]);
      setEdits({}); setDraft(loaded.payload); setStatus(loaded.payload.state === 'ready' ? (requiresReview ? 'review' : 'ready') : 'incomplete'); setMessage(loaded.payload.state === 'ready' ? (requiresReview ? 'Review required before approval.' : 'Ready to approve — direct extraction') : 'Incomplete — not eligible for approval.');
      void refreshSummary();
    } catch (error) { setStatus('failed'); setMessage(error instanceof Error ? error.message : 'Import failed.'); }
  }

  async function saveEdits() {
    if (!draft || !projectId || !window.prompterApi) return;
    setBusy(true);
    try {
      let revision = draft.revision;
      for (const [blockId, text] of Object.entries(edits)) {
        const result = await window.prompterApi.applyPrepReviewChange(projectId, draft.draftId, revision, { operationId: `op_${crypto.randomUUID()}`, kind: 'replace_block_text', blockId, text, reason: 'user_edit' });
        if (!result.ok) throw new Error(result.error.message);
        revision = result.payload.revision;
      }
      const loaded = await window.prompterApi.getPrepDraft(projectId, draft.draftId);
      if (!loaded.ok) throw new Error(loaded.error.message);
      setDraft(loaded.payload); setEdits({}); setStatus('draft'); setMessage('Edits saved. Approve to create a new immutable version.');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function review(operation: Parameters<NonNullable<typeof window.prompterApi>['applyPrepReviewChange']>[3]) {
    if (!draft || !window.prompterApi || !projectId) return;
    const result = await window.prompterApi.applyPrepReviewChange(projectId, draft.draftId, draft.revision, operation);
    if (!result.ok) { setStatus('failed'); setMessage(result.error.message); return; }
    const loaded = await window.prompterApi.getPrepDraft(projectId, draft.draftId);
    if (loaded.ok) {
      const unresolved = loaded.payload.diagnostics.some((item) => item.severity === 'review_required' && !loaded.payload.resolvedDiagnostics?.[item.id]);
      setDraft(loaded.payload); setStatus(unresolved ? 'review' : 'ready'); setMessage(unresolved ? 'Review required before approval.' : 'All required decisions are recorded. Ready to approve.');
    }
  }

  async function approve() {
    if (!draft || !window.prompterApi) return;
    if (!projectId) return;
    const result = await window.prompterApi.approvePrepDraft(projectId, draft.draftId, draft.revision);
    if (!result.ok) { setStatus('failed'); setMessage(result.error.message); return; }
    setStatus('approved'); setMessage('Approved manuscript created. This version is immutable and identified by its text hash.'); void refreshSummary();
  }

  const label = status === 'ready' ? 'Ready to approve' : status === 'review' ? 'Review required' : status === 'approved' ? 'Approved' : status === 'failed' ? 'Failed' : status === 'incomplete' ? 'Incomplete' : status === 'draft' ? 'Draft extraction' : 'No manuscript prepared';
  return <div className="prep-workspace" role="dialog" aria-modal="true" aria-label="Manuscript Prep">
    <header><div><strong>Manuscript Prep</strong><span className={`prep-status prep-${status}`}>{label}</span></div><button onClick={onClose}>Close</button></header>
    <p className="prep-message">{message}{projectId ? ` Project ${projectId.slice(-8)}.` : ''}</p>
    <div className="prep-actions"><button className="button-primary" onClick={() => void importText()}>Prepare TXT, DOCX or PDF source</button>{draft && status !== 'approved' && <button disabled={busy || Object.keys(edits).length > 0 || draft.diagnostics.some(item => item.severity === 'review_required' && !draft.resolvedDiagnostics?.[item.id])} className="button-primary" onClick={() => void approve()}>Approve manuscript for narration and Proofer</button>}</div>
    {Object.keys(edits).length > 0 && <button disabled={busy} onClick={() => void saveEdits()}>Save draft edits before approval</button>}
    {draft && <section><h2>Draft extraction</h2><p>Source file: {draft.source.displayName} · Direct extraction · Revision {draft.revision}</p><p>{draft.diagnostics.map((item) => item.message).join(' ')}</p>
      {draft.diagnostics.filter((item) => item.severity === 'review_required').map((item) => { const resolved = draft.resolvedDiagnostics?.[item.id]; const count = item.blockIds?.length ?? 0; return <div className="prep-review-decision" key={item.id}><strong>{resolved ? `Decision recorded: ${resolved.replace('_', ' ')}` : 'Review required'}</strong><p>{item.message} Affected source item{count === 1 ? '' : 's'}: {count}.</p><p>{item.groupId ? 'This action will affect every item in this detected repeated group.' : 'This action affects the identified source item.'}</p>{!resolved && <div className="prep-actions"><button onClick={() => void review({ operationId: `op_${crypto.randomUUID()}`, kind: 'resolve_diagnostic', diagnosticId: item.id, resolution: 'keep_included', reason: 'narrator_keep' })}>Keep included</button>{!item.blockIds?.length ? <button onClick={() => void review({ operationId: `op_${crypto.randomUUID()}`, kind: 'resolve_diagnostic', diagnosticId: item.id, resolution: 'reviewed', reason: 'narrator_review' })}>Reading order reviewed</button> : item.groupId ? <button onClick={() => void review({ operationId: `op_${crypto.randomUUID()}`, kind: 'apply_repetition_rule', diagnosticId: item.id, groupId: item.groupId, included: false, resolution: 'exclude', reason: 'narrator_exclude_repeated_group' })}>Exclude repeated group ({count})</button> : <button onClick={() => void review({ operationId: `op_${crypto.randomUUID()}`, kind: 'set_block_inclusion', blockId: item.blockIds?.[0], included: false, diagnosticId: item.id, resolution: 'exclude', reason: 'narrator_exclude_item' })}>Exclude this item</button>}</div>}{resolved && item.groupId && <button onClick={() => void review({ operationId: `op_${crypto.randomUUID()}`, kind: 'apply_repetition_rule', diagnosticId: item.id, groupId: item.groupId, included: true, resolution: 'keep_included', reason: 'narrator_restore_repeated_group' })}>Restore repeated group ({count})</button>}</div>; })}
      {draft.blocks.map((block) => <div key={block.id}><small>Source: {block.source?.story ?? 'body'} · item {block.source?.paragraphIndex ?? block.position + 1}{block.source?.inTable ? ' · table' : ''}{block.source?.reviewGroup ? ' · repeated group' : ''}{!block.included ? ' · excluded' : ''}</small><textarea aria-label={`Prepared paragraph ${block.position + 1}`} disabled={busy} value={edits[block.id] ?? block.replacementText ?? block.generatedText} onChange={(event) => setEdits(current => ({ ...current, [block.id]: event.target.value }))} /></div>)}
    </section>}
    {summary?.approved.length ? <section><h2>Approved history</h2><ul>{summary.approved.map((item) => <li key={item.approvedId}>{item.approvedAt} · {item.sourceDisplayName} · {item.textSha256.slice(0, 12)} <button disabled={busy} onClick={() => { if (projectId) void window.prompterApi?.readPrepApproved(projectId, item.approvedId).then(onSelect).catch(error => setMessage(String(error))); }}>Use this approved manuscript</button> <button onClick={() => { if (projectId) void window.prompterApi?.exportPrepApproved(projectId, item.approvedId).then(value => { if (value) setMessage("Exported the exact approved UTF-8 bytes."); }).catch(error => setMessage(String(error))); }}>Export UTF-8 for Proofer</button></li>)}</ul></section> : null}
  </div>;
}

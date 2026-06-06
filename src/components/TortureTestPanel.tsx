import { useCallback, useEffect, useMemo, useState } from 'react';
import { TORTURE_FIXTURES } from '../domain/tortureFixtures';
import {
  createTortureHarnessState,
  findTortureStartToken,
  runTortureChunk
} from '../domain/tortureHarness';
import type { ManuscriptModel } from '../domain/types';
import type { TortureHarnessState, TorturePosition, TortureStepReport } from '../domain/tortureHarness';

type Props = {
  model: ManuscriptModel;
  currentTokenIndex: number;
  onLoadManuscript(text: string): void;
};

function parseChunks(scriptText: string) {
  return scriptText.length === 0 ? [] : scriptText.replace(/\r\n/g, '\n').split('\n');
}

function formatPosition(position: TorturePosition) {
  return `T${position.tokenIndex} / S${position.sentenceIndex + 1} / P${position.paragraphIndex + 1}`;
}

function formatTokens(tokens: string[]) {
  return tokens.length > 0 ? tokens.join(' ') : 'Empty';
}

function reportSummary(report: TortureStepReport) {
  const chunk = report.rawTranscriptChunk.trim() || '[pause]';
  return `${chunk} -> ${report.appState} (${report.confidenceScore.toFixed(3)})`;
}

export function TortureTestPanel({ model, currentTokenIndex, onLoadManuscript }: Props) {
  const defaultFixture = TORTURE_FIXTURES[0];
  const [selectedFixtureId, setSelectedFixtureId] = useState(defaultFixture.id);
  const [scriptText, setScriptText] = useState(defaultFixture.chunks.join('\n'));
  const [startSearch, setStartSearch] = useState(defaultFixture.startTokenSearch ?? '');
  const [startOccurrence, setStartOccurrence] = useState(defaultFixture.startTokenSearchOccurrence ?? 0);
  const [delayMs, setDelayMs] = useState(650);
  const [nextChunkIndex, setNextChunkIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [reports, setReports] = useState<TortureStepReport[]>([]);
  const [harnessState, setHarnessState] = useState<TortureHarnessState>(() =>
    createTortureHarnessState(model, currentTokenIndex)
  );

  const chunks = useMemo(() => parseChunks(scriptText), [scriptText]);
  const lastReport = reports[0];

  const resolveStartToken = useCallback(() => {
    return startSearch.trim()
      ? findTortureStartToken(model, startSearch, startOccurrence)
      : currentTokenIndex;
  }, [currentTokenIndex, model, startOccurrence, startSearch]);

  const resetHarness = useCallback(() => {
    setIsPlaying(false);
    setNextChunkIndex(0);
    setReports([]);
    setHarnessState(createTortureHarnessState(model, resolveStartToken(), 'following'));
  }, [model, resolveStartToken]);

  useEffect(() => {
    resetHarness();
  }, [model.rawText]);

  const loadSelectedFixture = useCallback(() => {
    const fixture = TORTURE_FIXTURES.find((candidate) => candidate.id === selectedFixtureId) ?? defaultFixture;
    setScriptText(fixture.chunks.join('\n'));
    setStartSearch(fixture.startTokenSearch ?? '');
    setStartOccurrence(fixture.startTokenSearchOccurrence ?? 0);
    onLoadManuscript(fixture.manuscriptText);
    const startToken = findTortureStartToken(
      model,
      fixture.startTokenSearch,
      fixture.startTokenSearchOccurrence ?? 0
    );
    setHarnessState(createTortureHarnessState(model, startToken, 'following'));
    setNextChunkIndex(0);
    setReports([]);
    setIsPlaying(false);
  }, [defaultFixture, model, onLoadManuscript, selectedFixtureId]);

  const useCurrentPosition = useCallback(() => {
    setStartSearch('');
    setStartOccurrence(0);
    setHarnessState(createTortureHarnessState(model, currentTokenIndex, 'following'));
    setNextChunkIndex(0);
    setReports([]);
    setIsPlaying(false);
  }, [currentTokenIndex, model]);

  const runNextChunk = useCallback(() => {
    if (nextChunkIndex >= chunks.length) {
      setIsPlaying(false);
      return;
    }

    const outcome = runTortureChunk(model, harnessState, chunks[nextChunkIndex] ?? '');
    setHarnessState(outcome.nextState);
    setReports((previous) => [outcome.report, ...previous].slice(0, 24));
    setNextChunkIndex((previous) => previous + 1);
  }, [chunks, harnessState, model, nextChunkIndex]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    if (nextChunkIndex >= chunks.length) {
      setIsPlaying(false);
      return undefined;
    }

    const timer = window.setTimeout(runNextChunk, delayMs);
    return () => window.clearTimeout(timer);
  }, [chunks.length, delayMs, isPlaying, nextChunkIndex, runNextChunk]);

  return (
    <section className="panel-section torture-panel">
      <h2>Torture Test</h2>
      <div className="torture-case-row">
        <select
          value={selectedFixtureId}
          onChange={(event) => setSelectedFixtureId(event.target.value)}
          aria-label="Torture fixture"
        >
          {TORTURE_FIXTURES.map((fixture) => (
            <option key={fixture.id} value={fixture.id}>
              {fixture.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={loadSelectedFixture}>Load Case</button>
      </div>

      <textarea
        className="torture-input"
        value={scriptText}
        onChange={(event) => setScriptText(event.target.value)}
        spellCheck={false}
      />

      <div className="inline-actions">
        <button type="button" onClick={runNextChunk} disabled={nextChunkIndex >= chunks.length}>
          Step
        </button>
        <button
          type="button"
          onClick={() => setIsPlaying((playing) => !playing)}
          disabled={nextChunkIndex >= chunks.length}
        >
          {isPlaying ? 'Stop' : 'Auto'}
        </button>
        <button type="button" onClick={resetHarness}>Reset</button>
        <button type="button" onClick={useCurrentPosition}>Start Current</button>
      </div>

      <div className="torture-settings">
        <label>
          Delay
          <input
            type="number"
            min={100}
            max={5000}
            step={50}
            value={delayMs}
            onChange={(event) => setDelayMs(Number(event.target.value))}
          />
        </label>
        <span>{nextChunkIndex} / {chunks.length}</span>
        <span>Start token {resolveStartToken()}</span>
      </div>

      {lastReport ? (
        <dl className="torture-report">
          <dt>Raw chunk</dt>
          <dd>{lastReport.rawTranscriptChunk || '[pause]'}</dd>
          <dt>Normalized tokens</dt>
          <dd>{formatTokens(lastReport.normalizedTranscriptTokens)}</dd>
          <dt>Best match</dt>
          <dd>{lastReport.bestManuscriptMatch || 'None'}</dd>
          <dt>Confidence</dt>
          <dd>{lastReport.confidenceScore.toFixed(3)}</dd>
          <dt>Previous position</dt>
          <dd>{formatPosition(lastReport.previousManuscriptPosition)}</dd>
          <dt>New position</dt>
          <dd>{formatPosition(lastReport.newManuscriptPosition)}</dd>
          <dt>Alignment position</dt>
          <dd>{formatPosition(lastReport.alignmentPosition)}</dd>
          <dt>State</dt>
          <dd>{lastReport.appState}</dd>
          <dt>Diagnostic</dt>
          <dd>{lastReport.diagnosticCode}</dd>
          <dt>Retake bias</dt>
          <dd>{lastReport.alignmentDiagnostics.retakeBiasApplied ? 'Applied' : 'No'}</dd>
          <dt>Duplicate/jump</dt>
          <dd>
            {lastReport.alignmentDiagnostics.duplicateJumpPenaltyApplied
              ? lastReport.alignmentDiagnostics.duplicateJumpCandidateRejected
                ? 'Penalty applied; candidate rejected'
                : 'Penalty applied'
              : 'No'}
          </dd>
          <dt>Search window</dt>
          <dd>{lastReport.searchWindow.fromToken} - {lastReport.searchWindow.toToken}</dd>
          <dt>Reason</dt>
          <dd>{lastReport.reason}</dd>
        </dl>
      ) : (
        <p className="torture-empty">No chunks run.</p>
      )}

      {reports.length > 1 ? (
        <ol className="torture-history">
          {reports.slice(1, 7).map((report, index) => (
            <li key={`${report.rawTranscriptChunk}-${index}`}>{reportSummary(report)}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

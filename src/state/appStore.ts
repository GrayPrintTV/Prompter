import type { DisplaySettings, LocalWhisperSettings } from '../domain/types';

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  fontFamily: 'Georgia, Cambria, "Times New Roman", serif',
  fontSizePx: 34,
  lineHeight: 1.55,
  textWidthCh: 64,
  paragraphSpacingEm: 1.35,
  readingZonePercent: 62,
  theme: 'dark'
};

export const DEFAULT_LOCAL_WHISPER_SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'turbo',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 4
};

export const SAMPLE_MANUSCRIPT = `The studio light blinked once, and Mara took that as permission to begin.

She drew a quiet breath, settled her eyes on the page, and read the first sentence as if it had been waiting for her all morning. The room did not answer. That was the bargain.

Halfway through the paragraph, she missed a word, stopped, and smiled at nobody. She backed up to the previous sentence and began again. The room did not answer. That was the bargain.

By noon, the manuscript had become less like a stack of pages and more like a trail through familiar woods. When she lost the path, she did not panic. She found the last true sentence, placed her voice there, and moved forward.`;

export const DEFAULT_MOCK_SCRIPT = `The studio light blinked once
and Mara took that as permission to begin
She drew a quiet breath settled her eyes on the page
and read the first sentence
[pause]
this is a pickup note ignore me
The room did not answer that was the bargain
Halfway through the paragraph she missed a word
damn let me take that again
She backed up to the previous sentence and began again
The room did not answer that was the bargain
By noon the manuscript had become less like a stack of pages`;

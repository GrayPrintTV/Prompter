export type ShortcutAction =
  | 'startStop'
  | 'toggleFollow'
  | 'pauseResume'
  | 'backSentence'
  | 'forwardSentence'
  | 'backParagraph'
  | 'forwardParagraph'
  | 'resync'
  | 'search'
  | 'fontUp'
  | 'fontDown'
  | 'fullScreen'
  | 'controls'
  | 'developerMode'
  | 'debug';

export type ShortcutDefinition = {
  action: ShortcutAction;
  label: string;
  keys: string;
};

export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  { action: 'startStop', label: 'Start/stop listening', keys: 'Ctrl+Alt+L' },
  { action: 'toggleFollow', label: 'Follow/manual', keys: 'Ctrl+Alt+F' },
  { action: 'pauseResume', label: 'Pause/resume', keys: 'Ctrl+Alt+P' },
  { action: 'backSentence', label: 'Back sentence', keys: 'Alt+Left' },
  { action: 'forwardSentence', label: 'Forward sentence', keys: 'Alt+Right' },
  { action: 'backParagraph', label: 'Back paragraph', keys: 'Alt+Up' },
  { action: 'forwardParagraph', label: 'Forward paragraph', keys: 'Alt+Down' },
  { action: 'resync', label: 'Resync', keys: 'Ctrl+Alt+R' },
  { action: 'search', label: 'Search', keys: 'Ctrl+F' },
  { action: 'fontUp', label: 'Increase font', keys: 'Ctrl+=' },
  { action: 'fontDown', label: 'Decrease font', keys: 'Ctrl+-' },
  { action: 'fullScreen', label: 'Full screen', keys: 'F11' },
  { action: 'controls', label: 'Show/hide controls', keys: 'Ctrl+Alt+C' },
  { action: 'developerMode', label: 'Developer mode', keys: 'Ctrl+Shift+D' },
  { action: 'debug', label: 'Debug panel', keys: 'Ctrl+`' }
];

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

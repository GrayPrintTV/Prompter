import { DEFAULT_SHORTCUTS } from '../shortcuts/shortcuts';

export function ShortcutHelp() {
  return (
    <div className="shortcut-grid">
      {DEFAULT_SHORTCUTS.map((shortcut) => (
        <div className="shortcut-row" key={shortcut.action}>
          <span>{shortcut.label}</span>
          <kbd>{shortcut.keys}</kbd>
        </div>
      ))}
    </div>
  );
}

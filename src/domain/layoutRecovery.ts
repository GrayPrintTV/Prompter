export type HiddenLayoutRecoveryInput = {
  controlsVisible: boolean;
  stageWidth: number;
  stageHeight: number;
  minimumWidth?: number;
  minimumHeight?: number;
};

export function shouldRecoverControlsFromHiddenLayout({
  controlsVisible,
  stageWidth,
  stageHeight,
  minimumWidth = 160,
  minimumHeight = 160
}: HiddenLayoutRecoveryInput) {
  return !controlsVisible && (stageWidth < minimumWidth || stageHeight < minimumHeight);
}

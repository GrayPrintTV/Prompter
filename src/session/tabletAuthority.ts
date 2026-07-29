export function rendererProjectionForTabletUpdate(
  tabletModeActive: boolean,
  movementSuppressedOnDesktop: boolean
): 'diagnostics-only' | 'adopt-authoritative-position' {
  return tabletModeActive || movementSuppressedOnDesktop
    ? 'diagnostics-only'
    : 'adopt-authoritative-position';
}

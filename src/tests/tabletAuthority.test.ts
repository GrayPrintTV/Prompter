import { describe, expect, it } from 'vitest';
import { rendererProjectionForTabletUpdate } from '../session/tabletAuthority';

describe('desktop/tablet movement authority', () => {
  it('keeps tablet-originated movement diagnostic-only while Tablet Mode is active', () => {
    expect(rendererProjectionForTabletUpdate(true, true)).toBe('diagnostics-only');
    expect(rendererProjectionForTabletUpdate(true, false)).toBe('diagnostics-only');
  });

  it('adopts the final accepted position after Tablet Mode exits without starting a provider', () => {
    expect(rendererProjectionForTabletUpdate(false, false)).toBe('adopt-authoritative-position');
  });
});

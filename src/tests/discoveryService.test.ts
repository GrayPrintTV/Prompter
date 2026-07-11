import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from '../../electron/server/DiscoveryService';

const metadata = { serverId: 'server-1', protocolMajor: 1, protocolMinor: 0, productVersion: '0.1.0', pairing: false, port: 43127 };

describe('DiscoveryService', () => {
  it('advertises once, updates pairing TXT metadata, and shuts down', async () => {
    const advertise = vi.fn(async () => undefined);
    const updateTxt = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    const createService = vi.fn(() => ({ advertise, updateTxt, end }));
    const discovery = new DiscoveryService(() => ({ createService, shutdown }) as never);
    await discovery.start('Prompter - Test-PC', metadata);
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompter', port: 43127 }));
    expect(advertise).toHaveBeenCalledOnce();
    await discovery.update({ ...metadata, pairing: true });
    expect(updateTxt).toHaveBeenCalledWith(expect.objectContaining({ pairing: '1', transport: 'ws-cleartext-lan-prototype' }));
    await discovery.stop();
    expect(end).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('surfaces advertisement startup errors in diagnostics', async () => {
    const discovery = new DiscoveryService(() => ({
      createService: () => ({ advertise: async () => { throw new Error('mDNS unavailable'); }, end: async () => undefined }),
      shutdown: async () => undefined
    }) as never);
    await expect(discovery.start('Prompter - Test-PC', metadata)).rejects.toThrow('mDNS unavailable');
    expect(discovery.diagnostics().lastError).toContain('mDNS unavailable');
  });
});

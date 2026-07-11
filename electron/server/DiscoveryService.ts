import ciao, { type CiaoService, type Responder } from '@homebridge/ciao';

export type DiscoveryMetadata = {
  serverId: string;
  protocolMajor: number;
  protocolMinor: number;
  productVersion: string;
  pairing: boolean;
  port: number;
};

export class DiscoveryService {
  private responder: Responder | null = null;
  private service: CiaoService | null = null;
  private lastError: string | null = null;

  constructor(private readonly responderFactory = () => ciao.getResponder()) {}

  async start(instanceName: string, metadata: DiscoveryMetadata) {
    await this.stop();
    try {
      this.responder = this.responderFactory();
      this.service = this.responder.createService({
        name: instanceName,
        type: 'prompter',
        port: metadata.port,
        txt: this.txt(metadata)
      });
      await this.service.advertise();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.stop();
      throw error;
    }
  }

  async update(metadata: DiscoveryMetadata) {
    if (!this.service) return;
    await this.service.updateTxt(this.txt(metadata));
  }

  async stop() {
    const service = this.service;
    const responder = this.responder;
    this.service = null;
    this.responder = null;
    if (service) await service.end().catch(() => undefined);
    if (responder) await responder.shutdown().catch(() => undefined);
  }

  diagnostics() {
    return { advertising: Boolean(this.service), serviceType: '_prompter._tcp.local.', lastError: this.lastError };
  }

  private txt(metadata: DiscoveryMetadata) {
    return {
      serverId: metadata.serverId,
      protocolMajor: String(metadata.protocolMajor),
      protocolMinor: String(metadata.protocolMinor),
      productVersion: metadata.productVersion,
      pairing: metadata.pairing ? '1' : '0',
      transport: 'ws-cleartext-lan-prototype',
      port: String(metadata.port)
    };
  }
}

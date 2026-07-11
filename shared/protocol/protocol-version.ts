export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

export type ProtocolVersion = {
  protocolMajor: number;
  protocolMinor: number;
};

export type ProtocolCompatibility =
  | { compatible: true; negotiatedMinor: number }
  | { compatible: false; reason: string };

export function checkProtocolCompatibility(remote: ProtocolVersion): ProtocolCompatibility {
  if (remote.protocolMajor !== PROTOCOL_MAJOR) {
    return {
      compatible: false,
      reason: `Unsupported protocol major ${remote.protocolMajor}; expected ${PROTOCOL_MAJOR}.`
    };
  }

  return {
    compatible: true,
    negotiatedMinor: Math.min(PROTOCOL_MINOR, remote.protocolMinor)
  };
}


import { smoothstep01 } from './math';

export interface LegGait {
  thigh: number;
  knee: number;
  ankle: number;
  toe: number;
  heelContact: number;
  toeOff: number;
}

function pulse(phase: number, center: number, halfWidth: number): number {
  const distance = Math.min(Math.abs(phase - center), 1 - Math.abs(phase - center));
  return smoothstep01(Math.max(0, 1 - distance / halfWidth));
}

export function legGait(phase: number): LegGait {
  const cycle = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
  // One foot strikes on its heel as the other pushes off at the toes.
  // The swing knee rises only after toe-off, never while that foot is planted.
  const heelContact = pulse(cycle, 0, 0.17);
  const toeOff = pulse(cycle, 0.50, 0.17);
  const knee = pulse(cycle, 0.77, 0.22);
  return {
    thigh: Math.cos(cycle * Math.PI * 2),
    knee,
    ankle: toeOff * 0.28 - heelContact * 0.22 - knee * 0.12,
    toe: toeOff * 0.24 - heelContact * 0.08,
    heelContact,
    toeOff,
  };
}

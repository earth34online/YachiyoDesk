import type { MotionProfile } from './types';

export function shouldCombineSkeletons(profile: Pick<MotionProfile, 'capabilities'>): boolean {
  // The PMX converter can export several bind-compatible MMD deformation
  // chains. The optimization has been observed to detach one sleeve even
  // though the source and exported vertex weights are mirror-symmetric.
  return !profile.capabilities.includes('pmx-converted');
}

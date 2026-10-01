import type { VRM } from '@pixiv/three-vrm';
import { Object3D } from 'three';
import type { MotionProfile } from './types';

/** Keep view rotation/zoom out of converted PMX spring inertia. */
export function prepareGenericPmxSpringSpace(vrm: VRM, profile: MotionProfile): number {
  if (profile.profileId !== 'generic-vrm' || !profile.capabilities.includes('pmx-converted')) return 0;
  const joints = [...(vrm.springBoneManager?.joints ?? [])].filter(joint => !joint.center);
  if (!joints.length) return 0;
  // The VRM library wraps a center's matrix elements in a Proxy to cache its
  // inverse. Isolate that on a child node: proxying the model root would slow
  // every skeleton/skin matrix calculation through that shared ancestor.
  const center = new Object3D();
  center.name = 'Runtime PMX Spring Reference';
  vrm.scene.add(center);
  let changed = 0;
  for (const joint of joints) {
    // Explicit centers are part of the source simulation contract.
    if (joint.center) continue;
    joint.center = center;
    changed++;
  }
  return changed;
}

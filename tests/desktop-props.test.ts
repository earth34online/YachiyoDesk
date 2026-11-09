import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { preparePropClip } from '../src/DesktopProps';

describe('authored prop action timing', () => {
  const makeClip=()=>new THREE.AnimationClip('reach',1,[new THREE.VectorKeyframeTrack('hand.position',[0,.3,.63,1],[0,0,0, 1,0,0, 1,1,0, 0,0,0])]);
  it('retains original drink samples and duration while independently retiming a copy',()=>{
    const source=makeClip(),before=Array.from(source.tracks[0].times),clip=preparePropClip(source,'cup');
    expect(source.duration).toBe(1);expect(Array.from(source.tracks[0].times)).toEqual(before);
    expect(clip.duration).toBe(3.8);expect(clip.tracks[0].values).toEqual(source.tracks[0].values);
    expect(clip.tracks[0].times.at(-1)).toBeCloseTo(3.8);
  });
  it('brings the hand back through exactly the grasp point before placing the object down',()=>{
    const source=makeClip(),clip=preparePropClip(source,'parcel'),track=clip.tracks[0] as THREE.VectorKeyframeTrack;
    const sample=()=> (track as unknown as {createInterpolant():THREE.Interpolant}).createInterpolant();
    const grasp=.3*2.2,release=clip.duration-grasp;
    const atGrasp=Array.from(sample().evaluate(grasp));
    for(const [i,value] of Array.from(sample().evaluate(release)).entries())expect(value).toBeCloseTo(atGrasp[i],6);
    expect(Array.from(sample().evaluate(clip.duration))).toEqual([0,0,0]);
    const top=.63*2.2;
    expect(Array.from(sample().evaluate(top+.1))).toEqual(Array.from(sample().evaluate(top+.55)));
    expect(source.duration).toBe(1);expect(source.tracks[0].times).toHaveLength(4);
  });
});

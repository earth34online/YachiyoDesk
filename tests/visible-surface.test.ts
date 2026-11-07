import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { visibleSurface } from '../src/visibleSurface';

describe('material visibility for contact queries', () => {
  it('uses the source UV channel, texture transform, wrap, alpha cutoff and opacity', () => {
    const map = new THREE.DataTexture(new Uint8Array([255,255,255,0,255,255,255,255]),2,1);
    map.magFilter = THREE.NearestFilter; map.wrapS = THREE.RepeatWrapping; map.channel = 1;
    const material = new THREE.MeshBasicMaterial({map,alphaTest:.5});
    expect(visibleSurface(material,{uv:new THREE.Vector2(.75,.5),uv1:new THREE.Vector2(.25,.5)})).toBe(false);
    expect(visibleSurface(material,{uv1:new THREE.Vector2(.75,.5)})).toBe(true);
    map.offset.x=.5; expect(visibleSurface(material,{uv1:new THREE.Vector2(.75,.5)})).toBe(false);
    map.offset.x=0; material.opacity=.4; expect(visibleSurface(material,{uv1:new THREE.Vector2(.75,.5)})).toBe(false);
    material.alphaTest=0; material.transparent=false; expect(visibleSurface(material,{uv1:new THREE.Vector2(.25,.5)})).toBe(true);
    material.visible=false; expect(visibleSurface(material,{uv1:new THREE.Vector2(.75,.5)})).toBe(false);
  });
  it('interpolates linear alpha at a cutout edge and follows the texture flip', () => {
    const map = new THREE.DataTexture(new Uint8Array([0,0,0,0,255,255,255,255]),1,2);
    map.magFilter=THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({map,alphaTest:.5});
    expect(visibleSurface(material,{uv:new THREE.Vector2(.5,.49)})).toBe(false);
    expect(visibleSurface(material,{uv:new THREE.Vector2(.5,.51)})).toBe(true);
    map.flipY=true; expect(visibleSurface(material,{uv:new THREE.Vector2(.5,.49)})).toBe(true);
  });
});

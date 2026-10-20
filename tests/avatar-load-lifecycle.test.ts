import * as THREE from 'three';
import { VRMUtils } from '@pixiv/three-vrm';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarRuntime } from '../src/AvatarRuntime';

const pending = vi.hoisted(() => [] as Array<{ resolve(value: any): void; reject(error: Error): void; progress(event: any): void }>);
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({ GLTFLoader: class {
  register() { return this; }
  load(_url: string, resolve: (value: any) => void, progress: (event: any) => void, reject: (error: Error) => void) {
    pending.push({ resolve, progress, reject });
  }
} }));
vi.mock('../src/ProceduralAnimator', () => ({ ProceduralAnimator: class { update = vi.fn(); setOriginalPmxPhysics = vi.fn(); } }));

const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS } = require('../electron/settings.cjs');
const { sanitizeMotionProfile } = require('../electron/motion-profile.cjs');
function fixture() {
  const runtime = Object.create(AvatarRuntime.prototype) as any;
  const pivot = new THREE.Group();
  Object.assign(runtime, { bootstrap: { modelUrl: 'appasset://test/model.vrm', character: {
    motionProfile: sanitizeMotionProfile({ capabilities: ['pmx-converted'] }),
  } }, callbacks: { onProgress: vi.fn(), onReady: vi.fn(), onFatal: vi.fn(), onSetupRequired: vi.fn() },
  settings: { ...DEFAULT_SETTINGS }, renderer: { setAnimationLoop: vi.fn(), compileAsync: vi.fn(async () => {}), dispose: vi.fn() },
  shadow: new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()),
  avatarPivot: pivot, interactiveMeshes: [], disposed: false, started: false, loading: null, loadSequence: 0,
  vrm: null, animator: null, garmentContact: null,
  prepareModel: vi.fn((vrm: any) => pivot.add(vrm.scene)), applyMotionProfile: vi.fn(),
  updateVrm: vi.fn(),
  usesRenderedFootprint: vi.fn(() => false), collectDiagnostics: vi.fn(() => ({ ready: true })),
  });
  return runtime;
}
function model() {
  const scene = new THREE.Group();
  return { scene, userData: { vrm: { scene, meta: { metaVersion: '1' }, springBoneManager: { joints: [], setInitState: vi.fn() } } }, parser: { json: {} } };
}
beforeEach(() => { pending.length = 0; vi.spyOn(VRMUtils, 'deepDispose'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('asynchronous avatar ownership', () => {
  it('retains live decoded images, then closes a shared ImageBitmap once on disposal', async () => {
    class Bitmap { close = vi.fn(); }
    vi.stubGlobal('ImageBitmap', Bitmap);
    const r = fixture(), loaded = model(), image = new Bitmap();
    const first = new THREE.Texture(image as any), second = new THREE.Texture(image as any);
    const material = new THREE.ShaderMaterial({ uniforms: { image: { value: second } } });
    Object.assign(material, { map: first });
    loaded.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
    loaded.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
    const load = r.load(); pending[0].resolve(loaded); await load;
    expect(image.close).not.toHaveBeenCalled();
    r.dispose(); r.dispose();
    expect(image.close).toHaveBeenCalledOnce();
  });
  it('shares one pending load and does not bind a second model after readiness', async () => {
    const r = fixture(), first = r.load(), second = r.load();
    expect(first).toBe(second); expect(pending).toHaveLength(1);
    pending[0].resolve(model()); await first; await r.load();
    expect(pending).toHaveLength(1); expect(r.callbacks.onReady).toHaveBeenCalledOnce();
    r.dispose();
  });
  it('disposes a late model and suppresses stale progress after the runtime exits', async () => {
    const r = fixture(), load = r.load(), loaded = model();
    const skeleton = new THREE.Skeleton([new THREE.Bone()]);
    skeleton.boneTexture = new THREE.DataTexture(new Float32Array(16), 4, 1, THREE.RGBAFormat, THREE.FloatType);
    const disposeBoneTexture = vi.spyOn(skeleton.boneTexture, 'dispose');
    const mesh = new THREE.SkinnedMesh(); mesh.bind(skeleton); loaded.scene.add(mesh);
    r.dispose(); const progress = r.callbacks.onProgress.mock.calls.length;
    pending[0].progress({ loaded: 1, total: 1 }); pending[0].resolve(loaded); await load;
    expect(r.callbacks.onProgress).toHaveBeenCalledTimes(progress);
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(loaded.scene);
    expect(r.callbacks.onReady).not.toHaveBeenCalled(); expect(r.callbacks.onFatal).not.toHaveBeenCalled();
    expect(r.prepareModel).not.toHaveBeenCalled(); expect(r.started).toBe(false);
    expect(disposeBoneTexture).toHaveBeenCalledOnce(); expect(skeleton.boneTexture).toBeNull();
  });
  it('does not restart the render loop when GPU footprint readback completes after disposal', async () => {
    const r = fixture(); let finish!: () => void;
    r.usesRenderedFootprint.mockReturnValue(true);
    r.measureRenderedFootprint = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const load = r.load(), loaded = model(); pending[0].resolve(loaded);
    await vi.waitFor(() => expect(r.measureRenderedFootprint).toHaveBeenCalledOnce());
    r.dispose(); finish(); await load;
    expect(r.renderer.setAnimationLoop.mock.calls.every(([callback]: any[]) => callback === null)).toBe(true);
    expect(r.callbacks.onReady).not.toHaveBeenCalled();
    expect(vi.mocked(VRMUtils.deepDispose).mock.calls.filter(([scene]) => scene === loaded.scene)).toHaveLength(1);
    expect(r.vrm).toBeNull(); expect(r.avatarPivot.children).toHaveLength(0);
  });
  it('cleans failed model preparation and allows an explicit retry', async () => {
    const r = fixture(), bad = model(); r.prepareModel.mockImplementationOnce(() => { throw new Error('Preparation failed'); });
    const first = r.load(); pending[0].resolve(bad); await first;
    expect(r.vrm).toBeNull(); expect(r.started).toBe(false);
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(bad.scene); expect(r.callbacks.onFatal).toHaveBeenCalledOnce();
    const retry = r.load(); pending[1].resolve(model()); await retry;
    expect(r.callbacks.onReady).toHaveBeenCalledOnce(); r.dispose();
  });
  it('cleans an invalid loaded GLTF and ignores a network rejection after exit', async () => {
    const r = fixture(), invalid = { scene: new THREE.Group(), userData: {} };
    const first = r.load(); pending[0].resolve(invalid); await first;
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(invalid.scene);
    const second = r.load(); r.dispose(); pending[1].reject(new Error('Aborted transport')); await second;
    expect(r.callbacks.onFatal).toHaveBeenCalledOnce();
  });
  it('keeps a model loaded while hidden, then resumes without a wall-time jump', async () => {
    const r = fixture(); r.setSuspended(true);
    const load = r.load(); pending[0].resolve(model()); await load;
    expect(r.started).toBe(true); expect(r.callbacks.onReady).toHaveBeenCalledOnce();
    expect(r.renderer.setAnimationLoop.mock.calls.every(([fn]: any[]) => fn === null)).toBe(true);
    r.previousTimestamp = 1234; r.lastRenderedTimestamp = 1234;
    r.setSuspended(false);
    expect(r.previousTimestamp).toBe(0); expect(r.lastRenderedTimestamp).toBe(0);
    expect(r.renderer.setAnimationLoop.mock.lastCall[0]).toBeTypeOf('function');
    const count = r.renderer.setAnimationLoop.mock.calls.length;
    r.setSuspended(false); expect(r.renderer.setAnimationLoop).toHaveBeenCalledTimes(count);
    r.dispose(); r.setSuspended(false);
    expect(r.renderer.setAnimationLoop.mock.lastCall[0]).toBeNull();
  });
  it('suspends an existing loop without advancing the animator', async () => {
    const r = fixture(), load = r.load(); pending[0].resolve(model()); await load;
    r.animator.update.mockClear();
    const queuedFrame = r.renderer.setAnimationLoop.mock.lastCall[0];
    r.setSuspended(true); queuedFrame(20000);
    expect(r.animator.update).not.toHaveBeenCalled();
    expect(r.renderer.setAnimationLoop.mock.lastCall[0]).toBeNull();r.dispose();
  });
  it('keeps shader compilation inside loading and cannot revive a disposed avatar', async () => {
    const r = fixture(); let finish!: () => void;
    r.renderer.compileAsync.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const load = r.load(), loaded = model(); pending[0].resolve(loaded);
    await vi.waitFor(() => expect(r.renderer.compileAsync).toHaveBeenCalledOnce());
    expect(r.started).toBe(false); expect(r.callbacks.onReady).not.toHaveBeenCalled();
    r.dispose(); finish(); await load;
    expect(r.callbacks.onReady).not.toHaveBeenCalled(); expect(r.callbacks.onFatal).not.toHaveBeenCalled();
    expect(vi.mocked(VRMUtils.deepDispose).mock.calls.filter(([scene]) => scene === loaded.scene)).toHaveLength(1);
    expect(r.renderer.setAnimationLoop.mock.calls.every(([fn]: any[]) => fn === null)).toBe(true);
  });
});

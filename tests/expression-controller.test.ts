import { describe, expect, it, vi } from 'vitest';
import { ExpressionController } from '../src/ExpressionController';

function fixture(names = ['happy', 'angry', 'blink', 'aa', 'custom']) {
  const values = new Map<string, number>(names.map(name => [name, name === 'custom' ? .6 : 0]));
  const manager = { expressionMap: Object.fromEntries(names.map(name => [name, {}])),
    setValue: (name: string, value: number) => values.set(name, value), update: vi.fn() };
  return { controller: new ExpressionController(manager as any), values, manager };
}

describe('expression channel ownership and transitions', () => {
  it('cross-fades an interrupted emotion from its displayed value while blink remains immediate', () => {
    const { controller, values } = fixture();
    controller.update(0, 'joy', .8, 0, .3);
    expect(values.get('happy')).toBeCloseTo(.8);
    controller.update(1, 'angry', 0, 0, 0);
    expect(values.get('happy')).toBeCloseTo(.8); expect(values.get('blink')).toBe(1);
    controller.update(.25, 'angry', 1, 0, .11);
    expect(values.get('happy')).toBeCloseTo(.4); expect(values.get('angry')).toBeCloseTo(.5);
    expect(values.get('blink')).toBe(.25); expect(values.get('custom')).toBe(.6);
    controller.update(0, null, 0, 0, .22);
    expect(values.get('happy')).toBe(0); expect(values.get('angry')).toBe(0);
  });
  it('preserves continuity when two interrupted reactions share one fallback morph', () => {
    const { controller, values } = fixture();
    controller.update(0, 'joy', .7, 0, .3);
    controller.update(0, 'greet', 0, 0, 0);
    expect(values.get('happy')).toBeCloseTo(.7);
    controller.update(0, 'greet', .8, .3, .22);
    expect(values.get('happy')).toBeCloseTo(.8); expect(values.get('aa')).toBeCloseTo(.24);
  });
  it('uses elapsed seconds for the same transition at 30 and 60 Hz', () => {
    const a = fixture(), b = fixture();
    for (const f of [a, b]) { f.controller.update(0, 'joy', .8, 0, .3); f.controller.update(0, 'angry', 1, 0, 0); }
    for (let i = 0; i < 3; i++) a.controller.update(0, 'angry', 1, 0, 1 / 30);
    for (let i = 0; i < 6; i++) b.controller.update(0, 'angry', 1, 0, 1 / 60);
    expect(a.values.get('happy')).toBeCloseTo(b.values.get('happy')!);
    expect(a.values.get('angry')).toBeCloseTo(b.values.get('angry')!);
  });
  it('resets owned channels without erasing an unrelated model expression', () => {
    const { controller, values } = fixture();
    controller.update(1, 'cheer', 1, .3, .3); expect(values.get('aa')).toBeCloseTo(.3);
    controller.reset();
    for (const name of ['happy', 'blink', 'aa']) expect(values.get(name)).toBe(0);
    expect(values.get('custom')).toBe(.6);
    controller.update(0, 'angry', 0, 0, 0); expect(values.get('happy')).toBe(0);
  });
  it('handles missing, split-blink and invalid input channels without non-finite weights', () => {
    const { controller, values } = fixture(['blink_l', 'blink_r', 'happy']);
    controller.update(.7, 'joy', 1, 0, .3);
    expect(values.get('blink_l')).toBe(.7); expect(values.get('blink_r')).toBe(.7);
    controller.update(NaN, 'joy', Infinity, NaN, Infinity);
    expect([...values.values()].every(Number.isFinite)).toBe(true);
    expect(() => new ExpressionController(undefined).update(1, 'joy', 1, 1)).not.toThrow();
  });
});

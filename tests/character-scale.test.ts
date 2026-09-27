import { describe, expect, it } from 'vitest';

const { switchCharacterScale, rememberCharacterScale } = require('../electron/character-scale.cjs') as {
  switchCharacterScale: (settings: Record<string, any>, id: string) => Record<string, any>;
  rememberCharacterScale: (settings: Record<string, any>, zoom: number) => Record<string, number>;
};

describe('per-character initial scale', () => {
  it('starts a new generic import at 35% without changing the Yachiyo preference', () => {
    const current = { activeCharacterId: 'yachiyo', zoom: 0.72, characterZooms: {} };
    const imported = switchCharacterScale(current, 'new-pmx');
    expect(imported.zoom).toBe(0.35);
    expect(imported.characterZooms.yachiyo).toBe(0.72);
    const adjusted = { ...imported, zoom: 0.48, characterZooms: rememberCharacterScale(imported, 0.48) };
    expect(switchCharacterScale(adjusted, 'yachiyo').zoom).toBe(0.72);
    expect(switchCharacterScale({ ...adjusted, ...switchCharacterScale(adjusted, 'yachiyo') }, 'new-pmx').zoom).toBe(0.48);
    expect(switchCharacterScale(current, 'constructor').zoom).toBe(0.35);
  });
});

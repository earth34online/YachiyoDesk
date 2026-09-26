'use strict';

const DEFAULT_CHARACTER_ZOOM = 0.35;

function switchCharacterScale(settings, nextId) {
  const remembered = { ...settings.characterZooms, [settings.activeCharacterId]: settings.zoom };
  return {
    activeCharacterId: nextId,
    zoom: Object.prototype.hasOwnProperty.call(remembered, nextId)
      ? remembered[nextId]
      : DEFAULT_CHARACTER_ZOOM,
    characterZooms: remembered,
  };
}

function rememberCharacterScale(settings, zoom) {
  return { ...settings.characterZooms, [settings.activeCharacterId]: zoom };
}

module.exports = { DEFAULT_CHARACTER_ZOOM, switchCharacterScale, rememberCharacterScale };

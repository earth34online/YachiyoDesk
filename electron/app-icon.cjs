'use strict';

const path = require('node:path');

function loadApplicationIcon(nativeImage, root) {
  const candidates = [
    path.join(root, 'characters', 'yachiyo', 'thumbnail.png'),
    path.join(root, 'app-icons', 'icon.png'),
    path.join(root, 'build', 'icon.png'),
  ];
  for (const candidate of candidates) {
    const icon = nativeImage.createFromPath(candidate);
    if (!icon.isEmpty()) return icon;
  }
  throw new Error('应用图标缺失：请恢复 app-icons/icon.png 或开发目录 build/icon.png。');
}

module.exports = { loadApplicationIcon };

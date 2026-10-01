import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { loadApplicationIcon } = require('../electron/app-icon.cjs');
describe('model-free runtime icon', () => {
  it('uses the packaged application icon when the restricted thumbnail is absent', () => {
    const visited: string[] = [];
    const nativeImage = { createFromPath(file: string) {
      visited.push(file); return { isEmpty: () => !file.endsWith(path.join('app-icons', 'icon.png')), file };
    } };
    const icon = loadApplicationIcon(nativeImage, '/resources');
    expect(icon.file).toBe(path.join('/resources', 'app-icons', 'icon.png'));
    expect(visited).toHaveLength(2);
  });
});

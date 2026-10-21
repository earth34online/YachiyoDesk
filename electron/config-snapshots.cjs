'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson, isId } = require('./ai-store.cjs');
const { sanitizeSettings } = require('./settings.cjs');
class ConfigSnapshots {
  constructor(directory) { this.directory = directory; }
  capture(settings, label = '手动快照') {
    const item = { format: 'yachiyodesk-settings', version: 1, id: crypto.randomUUID(), label: String(label).slice(0, 80), createdAt: new Date().toISOString(), settings: sanitizeSettings(settings) };
    writeJson(this.file(item.id), item); return item;
  }
  file(id) { if (!isId(id)) throw new Error('快照标识无效。'); return path.join(this.directory, `${id}.json`); }
  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).flatMap(name => {
      try { const item = this.read(path.join(this.directory, name)); return [{ id: item.id, label: item.label, createdAt: item.createdAt }]; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  read(filename) {
    const item = readJson(filename, null, 1024 * 1024);
    if (item?.format !== 'yachiyodesk-settings' || item.version !== 1 || !isId(item.id)
      || typeof item.label !== 'string' || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || !item.settings || typeof item.settings !== 'object' || Array.isArray(item.settings)) throw new Error('这不是受支持的设置快照。');
    return { ...item, settings: sanitizeSettings(item.settings) };
  }
  preview(id, current) {
    const item = this.read(this.file(id));
    return { ...item, changes: Object.keys(item.settings).filter(key => JSON.stringify(item.settings[key]) !== JSON.stringify(current[key]))
      .map(key => ({ key, before: current[key], after: item.settings[key] })) };
  }
}
module.exports = { ConfigSnapshots };

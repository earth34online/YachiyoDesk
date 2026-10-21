const fs = require('node:fs');
const path = require('node:path');

function sharedFiles(source) {
  const files = [];
  const collect = relative => {
    const absolute = path.join(source, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(filename);
      else if (/\.(ts|css|cjs|mjs|py|json|ps1|md|yaml|vrma)$/.test(entry.name)
        || filename === path.join('electron', 'THIRD_PARTY_LICENSES.txt')) files.push(filename);
    }
  };
  for (const directory of ['src', 'electron', 'tests', 'converter', 'scripts', 'skills', 'assets/motions']) collect(directory);
  const documents = path.join(source, 'docs');
  if (fs.existsSync(documents)) for (const entry of fs.readdirSync(documents, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join('docs', entry.name));
  }
  for (const filename of ['index.html', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'md/CURRENT_STATUS.md']) {
    if (fs.existsSync(path.join(source, filename))) files.push(filename);
  }
  return files.sort();
}

function planSync(source, target) {
  source = fs.realpathSync(source);
  target = fs.realpathSync(target);
  if (path.basename(source) !== 'YachiyoDesk-public' || path.basename(target) !== 'YachiyoDesk'
    || path.dirname(source) !== path.dirname(target)) throw new Error('Sync requires sibling YachiyoDesk-public and YachiyoDesk directories');
  const publicPackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const localPackage = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  const expectedPackage = { ...localPackage };
  for (const key of ['name', 'version', 'main', 'type', 'scripts', 'dependencies', 'devDependencies']) {
    expectedPackage[key] = publicPackage[key];
  }
  if (publicPackage.build) {
    expectedPackage.build = structuredClone(publicPackage.build);
    if (localPackage.build?.copyright) expectedPackage.build.copyright = localPackage.build.copyright;
    for (const resource of expectedPackage.build.extraResources ?? []) {
      if (resource.from === 'characters') resource.filter = ['**/*'];
    }
  }
  const entries = sharedFiles(source).map(file => ({ file, contents: fs.readFileSync(path.join(source, file)) }));
  for (const [document, aliases] of [
    ['docs/LOCAL_USAGE.md', ['README_使用说明.md', 'release/先看这里_使用说明.md']],
    ['docs/ARCHITECTURE.md', ['项目原理与实现详解.md']],
    [fs.existsSync(path.join(source, 'docs/RELEASE_20261020.md')) ? 'docs/RELEASE_20261020.md' : 'docs/RELEASE_20261006.md', ['release/验证报告.md']],
  ]) {
    const filename = path.join(source, document);
    if (fs.existsSync(filename)) for (const alias of aliases) {
      let contents = fs.readFileSync(filename);
      // Mirrors live outside docs; resolve their relative links from the
      // destination folder as well (including release/ usage/report copies).
      const prefix = path.relative(path.dirname(alias), path.dirname(document)).replace(/\\/g, '/');
      contents = Buffer.from(contents.toString('utf8')
        .replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)]+)\)/gi, `](${prefix}/$1)`));
      entries.push({ file: alias, contents });
    }
  }
  entries.push({ file: 'package.json', contents: Buffer.from(JSON.stringify(expectedPackage, null, 2) + '\n') });
  const lockPath = path.join(source, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.name = expectedPackage.name;
    lock.version = expectedPackage.version;
    if (lock.packages?.['']) lock.packages[''].license = expectedPackage.license;
    entries.push({ file: 'package-lock.json', contents: Buffer.from(JSON.stringify(lock, null, 2) + '\n') });
  }
  const differences = entries.filter(entry => {
    const filename = path.join(target, entry.file);
    return !fs.existsSync(filename) || !fs.readFileSync(filename).equals(entry.contents);
  });
  return { source, target, version: publicPackage.version, entries, differences };
}

function applySync(plan) {
  for (const entry of plan.differences) {
    const filename = path.join(plan.target, entry.file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, entry.contents);
  }
}

if (require.main === module) {
  try {
    const project = path.resolve(__dirname, '..');
    const parent = path.dirname(project);
    const source = path.join(parent, 'YachiyoDesk-public');
    const target = path.join(parent, 'YachiyoDesk');
    if ((!fs.existsSync(source) || !fs.existsSync(target)) && process.argv.includes('--if-present')) {
      console.log('Sibling source/local pair absent; standalone checkout.');
    } else {
      const plan = planSync(source, target);
      if (process.argv.includes('--apply')) applySync(plan);
      const remaining = process.argv.includes('--apply') ? planSync(source, target).differences : plan.differences;
      console.log(JSON.stringify({ version: plan.version, sharedFiles: plan.entries.length,
        updated: process.argv.includes('--apply') ? plan.differences.length : 0,
        differences: remaining.map(entry => entry.file.replaceAll('\\', '/')) }, null, 2));
      if (remaining.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { sharedFiles, planSync, applySync };

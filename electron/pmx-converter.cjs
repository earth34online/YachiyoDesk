'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_PMX_BYTES = 1024 * 1024 * 1024;
const MAX_LOG_CHARS = 16000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function uniqueExistingFile(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue through all supported local layouts.
    }
  }
  return null;
}

function resolvePmxConverter(options = {}) {
  const moduleDirectory = options.moduleDirectory || __dirname;
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const portableDirectory = options.portableDirectory || process.env.PORTABLE_EXECUTABLE_DIR;
  const blenderName = path.join('blender-4.5.13-windows-x64', 'blender.exe');
  const blenderCandidates = [
    options.blenderPath,
    process.env.YACHIYO_BLENDER_PATH,
    path.resolve(moduleDirectory, '..', '..', '.tools', blenderName),
    resourcesPath && path.resolve(resourcesPath, '..', '..', '..', '..', '.tools', blenderName),
    portableDirectory && path.resolve(portableDirectory, '..', '..', '.tools', blenderName),
  ];
  const scriptCandidates = [
    options.scriptPath,
    process.env.YACHIYO_PMX_CONVERTER_SCRIPT,
    resourcesPath && path.join(resourcesPath, 'converter', 'pmx_to_vrm.py'),
    path.resolve(moduleDirectory, '..', 'converter', 'pmx_to_vrm.py'),
  ];
  const blenderPath = uniqueExistingFile(blenderCandidates);
  const scriptPath = uniqueExistingFile(scriptCandidates);
  if (!blenderPath) {
    throw new Error('没有找到本机 PMX 转换引擎。请保留 F:\\create\\.tools\\blender-4.5.13-windows-x64，或设置 YACHIYO_BLENDER_PATH。');
  }
  if (!scriptPath) throw new Error('PMX 转换脚本缺失，请重新解压或重新构建 YachiyoDesk。');
  const inferredToolsRoot = path.dirname(path.dirname(blenderPath));
  const blenderUserResources = options.blenderUserResources
    || process.env.YACHIYO_BLENDER_USER_RESOURCES
    || path.join(inferredToolsRoot, 'blender-user');
  return { blenderPath, scriptPath, blenderUserResources };
}

function validatePmxSource(sourcePath) {
  if (typeof sourcePath !== 'string' || path.extname(sourcePath).toLowerCase() !== '.pmx') {
    throw new Error('请选择扩展名为 .pmx 的模型文件。');
  }
  let stats;
  try {
    stats = fs.statSync(sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('找不到所选 PMX 文件。请确认文件没有移动或删除。');
    throw error;
  }
  if (!stats.isFile() || stats.size < 32 || stats.size > MAX_PMX_BYTES) {
    throw new Error('PMX 文件大小无效，支持范围为 32 字节到 1 GB。');
  }
  const header = Buffer.alloc(4);
  const handle = fs.openSync(sourcePath, 'r');
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString('ascii', 0, 4) !== 'PMX ') throw new Error('文件头不是有效的 PMX 2.x 模型。');
  return stats;
}

function appendLimited(current, chunk) {
  const combined = current + String(chunk);
  return combined.length <= MAX_LOG_CHARS ? combined : combined.slice(-MAX_LOG_CHARS);
}

function describePmxConversionFailure(error) {
  const report = error?.report;
  if (report?.missingTextures?.length) {
    const files = report.missingTextures.slice(0, 4).map((item) => path.basename(item.expected)).join('、');
    return `模型引用的贴图缺失或文件名不匹配：${files}。请完整解压 PMX 和贴图目录后重试。`;
  }
  if (report?.stage === 'humanoid-mapping') {
    return `骨骼映射失败：${report.error || '缺少 VRM 所需的人形骨骼'}。请检查 PMX 骨骼结构。`;
  }
  if (report?.stage === 'vrm-export') {
    return `VRM 导出失败：${report.error || '导出器未返回原因'}。详细诊断已写入本机日志。`;
  }
  if (report?.stage === 'addon-setup') {
    return `转换引擎依赖加载失败：${report.error || '缺少 Blender 扩展'}。请检查本机 Blender 与扩展安装。`;
  }
  if (report?.stage === 'garment-and-material-setup') {
    return `服装物理或材质配置失败：${report.error || '模型数据无法处理'}。详细诊断已写入本机日志。`;
  }
  if (report?.stage === 'pmx-import') {
    return `PMX 解析或导入失败：${report.error || '模型文件或资源无法读取'}。详细诊断已写入本机日志。`;
  }
  return error?.message || 'PMX 转换失败，详细诊断已写入本机日志。';
}

async function convertPmxToVrm({ sourcePath, outputPath, reportPath, timeoutMs = DEFAULT_TIMEOUT_MS, converter }) {
  validatePmxSource(sourcePath);
  const resolvedConverter = converter || resolvePmxConverter();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const runAttempt = (compatibilityMode) => new Promise((resolve, reject) => {
    const child = spawn(resolvedConverter.blenderPath, [
      '--background',
      '--factory-startup',
      '--python', resolvedConverter.scriptPath,
      '--', sourcePath, outputPath, reportPath,
      ...(compatibilityMode ? ['--compatibility-mode'] : []),
    ], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        BLENDER_USER_RESOURCES: resolvedConverter.blenderUserResources,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        error.stdout ??= stdout;
        error.stderr ??= stderr;
        reject(error);
      }
      else resolve({ report, stdout, stderr, converter: resolvedConverter });
    };
    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.once('error', (error) => finish(new Error(`无法启动 PMX 转换引擎：${error.message}`)));
    child.once('close', (code, signal) => {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch {
        // The process output below still provides a useful diagnostic.
      }
      if (code !== 0 || report?.result !== 'PASS' || !fs.existsSync(outputPath)) {
        const detail = report?.error || stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `退出代码 ${code}${signal ? `，信号 ${signal}` : ''}`;
        const error = new Error(`PMX 转换失败：${detail}`);
        error.report = report;
        error.stdout = stdout;
        error.stderr = stderr;
        // A native Blender crash has no JSON report. Retry once with the
        // isolated add-on compatibility path instead of sacrificing quality
        // for every model that works in the ordinary conversion mode.
        error.nativeCrash = code !== 0 && !report;
        finish(error);
        return;
      }
      finish(null, report);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`PMX 转换超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止并回滚。`));
    }, timeoutMs);
  });
  try {
    return await runAttempt(false);
  } catch (error) {
    if (!error.nativeCrash) throw error;
    return runAttempt(true);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_PMX_BYTES,
  convertPmxToVrm,
  describePmxConversionFailure,
  resolvePmxConverter,
  validatePmxSource,
};

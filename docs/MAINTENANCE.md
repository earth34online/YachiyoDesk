# 当前维护与交付

更新日期：2026-10-20。当前工作区：**1.0.9，1.x 收官版**。

## 两份项目的职责

| 目录 | 职责 |
|---|---|
| `F:\create\YachiyoDesk-public` | 公开源码、共享实现、测试与公开构建配置 |
| `F:\create\YachiyoDesk` | 同版本桌面运行与本地角色资产 |

两份项目共享 `src`、`electron`、`converter`、`tests`、公共脚本、依赖版本、构建入口和叙述性文档。桌面项目另外保留本地角色、资产准备脚本和本机版权元数据。角色资产保存在各自的 `characters` 目录，不参与文档或源码同步。

## 修改和验证

在公开项目中维护共享内容，然后执行：

```powershell
npm run sync:local
npm run verify
```

桌面项目执行同一套验证：

```powershell
Set-Location F:\create\YachiyoDesk
npm run verify
```

`verify` 包含类型检查、维护中的单元测试、前端构建及两版同步检查。独立公开 checkout 没有本机桌面目录时，验证只执行该 checkout 的检查。

`sync:local` 同步内容，`sync:check` 检查差异。共用说明、变更记录、架构、安装、需求和版本文档同样纳入同步；本机使用说明及项目原理入口由对应文档生成。

## 构建和程序入口

公开版执行 `npm run dist` 生成便携版和安装版，产物位于 `release`。桌面项目可执行 `npm run verify` 后，再执行 `node scripts/package.cjs --win --dir` 更新 `release\win-unpacked`。

当前桌面快捷方式使用 `F:\create\YachiyoDesk\release\win-unpacked\YachiyoDesk.exe`。公开版的模型过滤规则保留在构建配置中；本机桌面构建包含本地角色资源。

源码同步与程序打包分别执行。每次程序更新后核对包内版本、核心文件及本地模型哈希。

## 测试和交付证据

维护中的测试统一在 `tests`，通过 `npm test` 运行。当前验证基线为 38 个文件、260 项测试。

无模型引导使用 `--onboarding-test`；有模型使用 `--smoke-test`。测试使用隔离配置目录。PMX 动作检查保留真实角色 manifest 和 PMX capability。

本轮证据保存在 `artifacts/airi-review-20261020`：四套服装、原生八千代、动作、内存与包内验证。历史 1.0.8 交付证据保留在 `artifacts/release-final-20261006`。发布文件的 SHA-256 保存到 `release/SHA256SUMS.txt`；生成校验文件不代表已经发布 GitHub Release。

## 目录整理规则

正式源代码、`tests`、`node_modules`、构建缓存、Blender 及其扩展、角色源文件和正式发布程序保留。已退出成品的实验库、临时解包程序、重复测试配置、实验截图和阶段性报告已清理。

保留当前交付证据，不再用旧实验包路径作为程序入口。下一次测试使用独立输出目录，并在记录结果后清理重复的测试模型与缓存。

2026-10-13 的清理复核确认：108 个运行、角色与构建文件的 SHA-256 均与清理前相同；两版类型检查、30 个文件／185 项测试及构建通过；实际解包程序的公开引导和桌面模型、UI、拖动、角色切换与比例恢复冒烟检查通过。94 项同步条目一致，当前叙述性文档的本地链接检查通过。

## 文档入口

- `README.md`：公开项目介绍、下载和开发入口。
- `CHANGELOG.md`：版本变更。
- `docs/LOCAL_USAGE.md`：本机桌面使用说明。
- `docs/INSTALLATION.md`：安装、导入和迁移。
- `docs/ARCHITECTURE.md`：实际实现与扩展点。
- `docs/REQUIREMENTS.md`：产品要求与回归清单。
- `docs/RELEASE_20261006.md`：1.0.8 成品交付记录。
- `docs/RELEASE_20261020.md`：本轮 1.0.9 验证与交付状态。
- `docs/AIRI_REVIEW_20261020.md`：AIRI 审查、适配条件及本轮修复依据。

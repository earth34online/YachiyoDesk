# 当前维护与交付

更新日期：2026-10-21。当前工作区：**2.0.0-beta.1 开发分支**；1.x 标签及交付记录保留。2.0 完成验证及审查前不提交或推送。

## 两份项目的职责

| 目录 | 职责 |
|---|---|
| `F:\create\YachiyoDesk-public` | 公开源码、共享实现、测试与公开构建配置 |
| `F:\create\YachiyoDesk` | 同版本桌面运行与本地角色资产 |

两份项目共享 `src`、`electron`、`converter`、`tests`、公共脚本、依赖版本、构建入口和叙述性文档。桌面项目另外保留本地角色、资产准备脚本和本机版权元数据。角色资产保存在各自的 `characters` 目录，不参与文档或源码同步。

本机维护前读取项目根目录的 `AGENTS.md`，其中整理项目所有者的修改约束。该文件仅本地保留，两份副本人工同步；由根目录 `/AGENTS.md` 忽略规则排除，不纳入共享同步清单、Git 提交或应用安装包。公开 checkout 不要求存在该本地文件。

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

公开版执行 `npm run dist` 生成便携版和安装版。当前 2.0 维护必须显式使用 `--config.directories.output=release/2.0.0-beta.1`，不再将旧 `release\win-unpacked` 作为桌面入口。

2.0 安装产物使用 `node scripts/package.cjs --win portable nsis --config.directories.output=release/2.0.0-beta.1`；两版解包构建使用同一版本目录的 `--win --dir`。2026-10-21 按用户要求统一共享源码、当前构建、桌面快捷方式及实际进程，再在这一基线上继续修复。旧文件删除已获用户授权，但自动审批两次拒绝，不能声称清理完成或换工具绕过。

当前桌面快捷方式使用 `F:\create\YachiyoDesk\release\2.0.0-beta.1\win-unpacked\YachiyoDesk.exe`。公开版的模型过滤规则保留在构建配置中；本机桌面构建包含本地角色资源。

源码同步与程序打包分别执行。每次程序更新后核对包内版本、核心文件及本地模型哈希。

## 测试和交付证据

维护中的测试统一在 `tests`，通过 `npm test` 运行。原 42 个文件、318 项为历史基线；当前套件为 51 个文件、376 项，覆盖接缝、受限蒙皮梯度、头部避让、缺碰撞导入、低面数内接/骨轴穿出、AI 方案范围和取消。两版分别执行完整 `verify`，同步后再核对包内容、模型哈希和实际进程；最新结果见 [本轮审查记录](REVIEW_20261021.md)。不得将模拟时钟、协议测试或没有 NaN 等同于全部视觉通过；当前人物原始物理另有 600.8 秒真实时间运行证据。

无模型引导使用 `--onboarding-test`；有模型使用 `--smoke-test`。测试使用隔离配置目录。PMX 动作检查保留真实角色 manifest 和 PMX capability。

2.0 证据保存在 `artifacts/2.0-development-20261020`；历史 1.x 与 1.0.8 证据按原目录保留。2.0 包的 SHA-256 保存到 `release/2.0.0-beta.1/SHA256SUMS.txt`；生成校验文件不代表已经发布 GitHub Release。

`scripts/check-companion-runtime.cjs` 在隔离配置中验证真实 IPC、HTTP、录音、朗读、动作、快照和导入预览，不使用付费密钥。通过 `YACHIYO_COMPANION_TEST_MODEL` 指定合法本地测试 VRM；`--extended-ui` 实测编排和一分钟提醒，`--pmx-repair` 供具备本机 PMX 测试资源与 Blender 的环境使用。普通 `npm test` 不依赖私有角色模型。

## 目录整理规则

正式源代码、`tests`、`node_modules`、构建缓存、Blender 及其扩展、角色源文件和正式发布程序保留。2026-10-13 已清理的旧实验产物以当时记录为准；当前 2.0 验证资料与测试配置仍保留，不把历史清理结果写成当前目录已全部清理。

保留当前交付证据，不再用旧实验包路径作为程序入口。下一次测试使用独立输出目录；清理前列出具体目标并核对受保护资产，不扩大到源模型、工具或日常配置。

本轮独立复现位于 `F:/create/artifacts/bug-audit-20261021`；模型和 inspection hook 仅用于隔离测试，不复制进正式源码或公开包。当前校服裂口已通过源位置/权重核对定位，不能仅凭静止画面推断原始绑定是否正确。每轮结束同步核对相关叙述文件及两份本地 `AGENTS.md`。

2026-10-13 的清理复核确认：108 个运行、角色与构建文件的 SHA-256 均与清理前相同；两版类型检查、30 个文件／185 项测试及构建通过；实际解包程序的公开引导和桌面模型、UI、拖动、角色切换与比例恢复冒烟检查通过。94 项同步条目一致，当前叙述性文档的本地链接检查通过。

## 文档入口

- `README.md`：公开项目介绍、下载和开发入口。
- `CHANGELOG.md`：版本变更。
- `docs/LOCAL_USAGE.md`：本机桌面使用说明。
- `docs/INSTALLATION.md`：安装、导入和迁移。
- `docs/ARCHITECTURE.md`：实际实现与扩展点。
- `docs/REQUIREMENTS.md`：产品要求与回归清单。
- `docs/RELEASE_20261006.md`：1.0.8 成品交付记录。
- `docs/RELEASE_20261020.md`：历史 1.0.9 验证与交付状态。
- `docs/AIRI_REVIEW_20261020.md`：1.x 阶段 AIRI 审查与适配依据；2.0 接入以开发记录为准。
- `docs/COMPANION_2.0.md`：AI 连接、导入修复与创作室操作。
- `docs/DEVELOPMENT_2.0.md`：2.0 要求、适配来源、验证和待审查状态。

本轮新增 `spring-arm-contacts.test.ts` 覆盖移动手臂、依赖缓存、重复接入、原始配置保留、近端错位胶囊体的等半径/等长副本、旋转/尺度及独立路径。实际角色另有原始分组、直接补引用、原始 PMX 和校正对齐的多方向对照；不能用接触点数下降替代视觉验收。

## 2026-10-21 桌面接触功能

新增接触功能后必须验证实际外部窗口而非只用模拟矩形：本机 DWM 查询、DIP 转换、完整下降路径、双脚平台宽度、遮挡、平移、消失、模态暂停和生命周期。脚本属于独立打包资源；核对最终包中 helper 与源码相同，实际辅助进程命令指向当前 resources。已有动作/模型文件的保护及两版同步规则继续适用。

详见 [桌面接触功能与验收](DESKTOP_CONTACTS_20261021.md)。

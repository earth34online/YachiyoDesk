# ✦ YachiyoDesk ✦

<div align="center">
  <img src="build/icon.png" alt="YachiyoDesk icon" width="128" height="128" />
  <p><strong>让一个高质量 VRM 角色住在你的桌面上</strong></p>
  <p>透明窗口 · 自主行走 · 自然动作 · VRM 导入 · PMX 本机转换 · 本地优先</p>
  <p>
    <a href="https://github.com/earth34online/YachiyoDesk/releases"><img src="https://img.shields.io/github/v/release/earth34online/YachiyoDesk?display_name=tag&style=for-the-badge" alt="Latest release" /></a>
    <a href="https://github.com/earth34online/YachiyoDesk/releases"><img src="https://img.shields.io/github/downloads/earth34online/YachiyoDesk/total?style=for-the-badge" alt="Downloads" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/earth34online/YachiyoDesk?style=for-the-badge" alt="License" /></a>
    <a href="https://github.com/earth34online/YachiyoDesk/actions/workflows/verify.yml"><img src="https://github.com/earth34online/YachiyoDesk/actions/workflows/verify.yml/badge.svg" alt="Verification" /></a>
  </p>
</div>

> **公开版说明**：仓库和 Release 发布的是软件代码与 Windows 构建包，不包含受限制的角色模型。首次启动没有模型是预期行为，请按照 [首次启动与日常操作](#首次启动与日常操作) 导入你有权使用的角色。

YachiyoDesk 是一个 Windows 本地桌面伴侣：使用 Electron + Three.js + `@pixiv/three-vrm` 渲染 VRM 角色，提供透明桌面窗口、拖动、点击互动、平滑待机/行走、动作与对白、状态面板、角色切换，以及在本机把 PMX 转换成 VRM 后导入。

> 你可以把它当作一个可扩展的本地角色运行时：模型属于你自己，程序负责加载、动作、交互、窗口和配置。

## ✨ 功能一览

| 模块 | 能力 | 说明 |
| --- | --- | --- |
| 桌面窗口 | 透明、无边框、置顶、边缘限制 | 不遮挡桌面，支持拖动和位置记忆 |
| 自主行为 | 底部行走、巡逻/随机方向、动作插播 | UI 连续 15 秒无操作会自动收起并恢复活动 |
| 人体动作 | 待机、走路、挥手、鞠躬、伸展、跳舞、思考、下蹲等 | 通用 VRM humanoid 骨骼映射，缺失骨骼时安全降级 |
| 互动系统 | 摸头、身体互动、拖动、右键面板、快捷互动栏 | 点击人物会立即中断自主行走 |
| 对白系统 | 角色对白、状态对白、随机闲聊 | 内容来自角色 manifest，可按角色替换 |
| 宠物状态 | 饱腹、精力、心情、亲密度 | 本地持久化，不联网上传 |
| 角色库 | 多角色、VRM 导入、角色切换、删除 | 角色存放于用户数据目录 |
| PMX 导入 | 本机 Blender PMX → VRM | 不上传原始 PMX，转换结果只保存在本机；当前不接受 `.pmd` 主模型 |
| 画质与性能 | Ultra/High/Balanced、自适应像素倍率 | 保留模型纹理，不用低模替代高质量模型 |
| 系统集成 | 系统托盘、桌面快捷方式、开机启动选项 | 可在设置中关闭，不强制常驻 |

## 目录

- [下载并运行](#下载并运行)
- [首次启动与日常操作](#首次启动与日常操作)
- [八千代模型：来源、署名和版权边界](#八千代模型来源署名和版权边界)
- [角色优先级与兼容性](#角色优先级与兼容性)
- [给想自己修改的开发者](#给想自己修改的开发者)
- [更多文档](#更多文档)
- [诊断与安全提示](#诊断与安全提示)
- [许可](#许可)

## 🔗 更多文档

| 文档 | 用途 |
| --- | --- |
| [安装与角色导入指南](docs/INSTALLATION.md) | 从下载校验到 VRM/PMX 导入、Blender 配置、迁移和常见问题 |
| [架构与扩展点](docs/ARCHITECTURE.md) | 了解主进程、renderer、动作系统、manifest 和通用角色标准 |
| [需求与验收清单](docs/REQUIREMENTS.md) | 历次产品要求、当前实现位置与明确兼容边界 |
| [变更记录](CHANGELOG.md) | 查看版本功能、版权策略和后续方向 |
| [安全与隐私](SECURITY.md) | 报告路径穿越、远程执行、资产泄露等安全问题 |

如果你只想使用程序，阅读“下载并运行”和[安装与角色导入指南](docs/INSTALLATION.md)即可；如果你想改动作、增加角色或调整 PMX 映射，再阅读[架构与扩展点](docs/ARCHITECTURE.md)。

## 下载并运行

### 方案 A：浏览器下载（推荐）

打开 [Releases](https://github.com/earth34online/YachiyoDesk/releases/latest)，在 **Assets** 区域选择一个版本：

- [便携版 Portable](https://github.com/earth34online/YachiyoDesk/releases/latest/download/YachiyoDesk-1.0.6-x64-Portable.exe)：下载后直接运行，不写入安装目录。
- [安装版 Setup](https://github.com/earth34online/YachiyoDesk/releases/latest/download/YachiyoDesk-1.0.6-x64-Setup.exe)：按向导安装，可创建桌面和开始菜单快捷方式。
- [`SHA256SUMS.txt`](https://github.com/earth34online/YachiyoDesk/releases/latest/download/SHA256SUMS.txt)：校验下载文件完整性。

下载后的操作顺序：

1. 如果你只想解压即用，双击 Portable；如果希望有卸载入口和快捷方式，运行 Setup。
2. Windows SmartScreen 如果提示“未知发布者”，请先确认文件来自本仓库 Release，并核对 SHA-256 后再选择“仍要运行”。公开包没有代码签名证书，SmartScreen 警告属于预期现象。
3. 第一次启动会先出现角色导入引导，不会直接显示八千代；这是因为模型文件不能随包再分发。

### 方案 B：PowerShell 下载并校验

下面的命令会把最新正式 Release 下载到当前用户的 Downloads 目录：

```powershell
$dir = Join-Path $env:USERPROFILE 'Downloads\YachiyoDesk'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$base = 'https://github.com/earth34online/YachiyoDesk/releases/latest/download'
Invoke-WebRequest "$base/YachiyoDesk-1.0.6-x64-Portable.exe" -OutFile (Join-Path $dir 'YachiyoDesk-1.0.6-x64-Portable.exe')
Invoke-WebRequest "$base/YachiyoDesk-1.0.6-x64-Setup.exe" -OutFile (Join-Path $dir 'YachiyoDesk-1.0.6-x64-Setup.exe')
Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile (Join-Path $dir 'SHA256SUMS.txt')
Set-Location $dir
Get-FileHash .\YachiyoDesk-1.0.6-x64-Portable.exe -Algorithm SHA256
Get-FileHash .\YachiyoDesk-1.0.6-x64-Setup.exe -Algorithm SHA256
```

确认哈希与 `SHA256SUMS.txt` 一致后运行其一：

```powershell
Start-Process .\YachiyoDesk-1.0.6-x64-Portable.exe
# 或者
Start-Process .\YachiyoDesk-1.0.6-x64-Setup.exe
```

`/releases/latest` 页面地址固定指向最新正式版本；Release asset 的文件名包含版本号，因此脚本中的 `1.0.6` 需要在下一次正式发布时同步更新。

首次公开版启动时不会内置八千代模型。请点击“打开角色库并导入”，导入你有权使用的 `.vrm`，或导入 `.pmx` 让本机转换器生成 VRM；之后在角色库中点击“使用”。模型会保存在 `%APPDATA%\YachiyoDesk\characters`，下次启动会自动使用已选择的角色。新导入角色首次启用时按 35% 显示；之后每个角色分别记住手动调整的比例，不会覆盖八千代已有的比例。透明置顶窗口和开机启动设置可在面板中调整。

### 首次启动与日常操作

1. 启动便携版或完成安装后启动安装版。
2. 首次出现“需要本地角色”时，点击“打开角色库并导入”。选择 VRM，或在已配置 Blender 的情况下选择 PMX 自动转换。
3. 在“角色库”卡片上点击“使用”。程序会重新载入角色，之后仍可从托盘菜单或设置面板切换角色。
4. 左键按住角色可拖动窗口；点击角色会立即停止自主行走并触发对应部位互动；滚轮在角色上调整大小；右键打开动作与设置面板。
5. 将鼠标移到角色附近可打开快捷互动栏；点击面板外部会关闭面板。主动关闭 UI 后连续 15 秒无交互会恢复行走；即使 UI 保持打开，只要连续 15 秒没有按键、点击或表单输入，也会自动收起并立即恢复活动。
6. 托盘图标可打开设置、角色库、数据目录、重置姿态或退出。设置中的“开机自动启动”可随时关闭，不会影响模型文件。

导入角色和转换结果仅写入当前 Windows 用户的数据目录，不会自动上传到 GitHub 或其他服务器。删除角色前请确认没有需要保留的本地转换结果。

## 八千代模型：来源、署名和版权边界

仓库和 Release **不包含八千代的 VRM、PMX、纹理或模型压缩包**。本地随项目保存的 `characters/yachiyo/MODEL_LICENSE.txt` 明确规定“再配布：NG”，因此不把模型数据上传到 GitHub，避免让使用者或维护者违反原作者条款。

八千代模型请从原作者水色の描提供的页面获取，并以下载页面当前的条款为准。优先使用[原作者的月见八千代 BOOTH 页面](https://booth.pm/ja/items/8157937)提供的免费 VRM 或包含 PMX 的压缩包；下列是作者其他发布渠道：

- [VRoid Hub](https://hub.vroid.com/users/98041368)
- [ニコニ立体](https://3d.nicovideo.jp/users/134997762)
- [BowlRoll](https://bowlroll.net/user/1004051)
- [BOOTH](https://mizuirononeko.booth.pm)

使用时必须保留原作者署名“水色の描”。当前许可文件还限制暴力、R-18、法人/个人商用和再分发，并允许改编；原作及相关角色权利仍归各权利人所有。若下载页的最新许可与仓库中的副本不同，应遵守最新许可。请不要把下载后的模型、纹理或改造后的模型提交到本仓库、Release、网盘或其他公共渠道。

## 角色优先级与兼容性

1. **原作者提供、与本软件直接匹配的八千代 VRM**：优先推荐，保留原始材质、表情、人体骨骼和 VRM SpringBone。导入时按原始文件 SHA-256 识别已验证版本并应用八千代专用动作、对白和衣物配置；仅靠文件名相同不会触发专用配置。原作者若更新文件，哈希变化后将先按通用角色处理，直到维护者重新验证。
2. **其他标准 VRM 1.0/0.x**：可通过“导入 VRM”使用。软件会读取 humanoid 骨骼并应用通用动作；缺失骨骼、非标准命名、没有 SpringBone 或表情的模型会自动降级，可能没有完整脚步、手掌朝向、视线或衣物摆动。
3. **PMX 本机转换**：通过“导入 PMX（自动转换）”调用本地 Blender 转换器。需要安装 Blender 4.x，并在设置或环境变量 `YACHIYO_BLENDER_PATH` 指向 `blender.exe`；转换会尽力映射人体骨骼、材质和物理。转换器检查蒙皮权重，仅对邻域骨骼归属一致的孤立缺权重顶点自动补权重；不确定的情况会提示并留在 `conversion-report.json`，不会乱改裙摆、袖口的混合边界。已识别的原作者八千代 PMX 会使用专用配置，同时保留 PMX 手腕/腿部坐标系补偿；其他 PMX 使用通用配置。对可识别的裙摆/袖子和身体蒙皮网格，运行时会尝试有预算上限的网格接触；不支持的结构或超时会回退原渲染。无法承诺任意模型完全零穿模或自动生成真实布料。重新导入 PMX 才会应用新版转换参数，既有 VRM 不会被静默覆盖。PMX 的非标准骨骼、刚体、Morph、复杂裙摆、特殊 toon 材质无法保证完全等价。转换后的结果存入用户数据目录，原 PMX 不会上传。当前只接受 `.pmx`，不接受 `.pmd` 主模型。

通用动作会根据模型能力自适应；八千代专属微调只在八千代 manifest 中启用，不会污染未来导入角色。任何第三方角色都应由使用者自行确认模型许可、二次创作规则和再分发限制。

## 给想自己修改的开发者

### 环境

- Windows 10/11
- Node.js 20+（推荐当前 LTS）和 npm
- 若需要 PMX 转换：Blender 4.x，并安装/配置 `YACHIYO_BLENDER_PATH`

### 获取源码并运行

先确认 Node.js 和 npm 可用：

```powershell
node --version   # 推荐 Node.js 20 或 22 LTS
npm --version
```

然后执行完整的首次构建：

```powershell
git clone https://github.com/earth34online/YachiyoDesk.git
cd YachiyoDesk
npm ci
npm run verify
npm run start
```

每条命令的作用如下：

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按 `package-lock.json` 安装精确版本依赖；首次运行和 CI 使用它 |
| `npm run typecheck` | 只执行 TypeScript 类型检查 |
| `npm test` | 执行 Vitest 单元测试 |
| `npm run build:renderer` | 构建 Vite renderer 到 `dist/` |
| `npm run verify` | 依次执行类型检查、测试和 renderer 构建 |
| `npm run start` | 先构建 renderer，再启动 Electron 应用 |

开发调试需要两个终端：

```powershell
# 终端 1：启动 Vite 开发服务器
npm run dev

# 终端 2：启动 Electron（读取开发服务器）
npm run electron:dev
```

关闭开发服务器后，生产构建仍然使用 `npm run start`。开发模式不会自动把模型复制进仓库；仍应通过角色库导入本地模型。

### 本地准备八千代或其他角色

不要把模型放进 Git。将你从原作者合法获取的 `model.vrm` 通过软件“角色库 → 导入 VRM”导入；或者使用 PMX 导入功能。开发者也可以在本地构建前将自己的模型放到 `characters/yachiyo/model.vrm`，但该文件会被 `.gitignore` 忽略，且不得提交或发布。公开构建故意不包含模型，首次运行的引导页就是预期行为。

PMX 转换器默认搜索常见的 Blender 4.x 安装位置，也可以显式设置：

```powershell
$env:YACHIYO_BLENDER_PATH = 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe'
```

转换时请把 PMX、同目录的纹理、`.sph/.spa` 球形贴图和 toon 纹理等依赖文件保留在原目录；转换完成后只将生成的 VRM 复制到应用数据目录，原始 PMX 不会被仓库收集。

### 构建发布包

```powershell
npm run dist:portable   # 只生成 Windows x64 便携版
npm run dist            # 生成 Windows x64 便携版 + NSIS 安装版
```

构建产物在 `release/`：

```text
release/
  YachiyoDesk-<version>-x64-Portable.exe
  YachiyoDesk-<version>-x64-Setup.exe
```

发布前建议按下面顺序操作：

```powershell
npm run verify
git diff --check
git ls-files | Select-String '\.(vrm|pmx|pmd|zip|7z|rar)$'
Get-ChildItem .\release -File | Get-FileHash -Algorithm SHA256
```

第一条命令和第二条命令必须成功；第三条命令应无输出。大型安装包应作为 GitHub Release asset 上传，而不是普通 Git blob；这是 GitHub 针对大型二进制文件的正常发布方式。[GitHub Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

### 代码结构

- `electron/main.cjs`：主进程、透明窗口、托盘、设置持久化、角色库、VRM/PMX 导入 IPC。
- `electron/pmx-converter.cjs`、`converter/pmx_to_vrm.py`：调用 Blender 的本机 PMX→VRM 转换流程。
- `src/AvatarRuntime.ts`：Three.js/VRM 加载、相机、物理、渲染循环和性能自适应。
- `src/ProceduralAnimator.ts`：通用人体动作、走路步态、手掌/肘部约束和角色动作。
- `src/AppUI.ts`、`src/InteractionController.ts`：设置面板、角色管理、拖动和鼠标互动。
- `characters/yachiyo/character.json`：八千代行为和动作配置；模型文件刻意不在仓库中。

### 提交前自检

```powershell
npm run verify
git diff --check
git ls-files | Select-String '\.(vrm|pmx|pmd|zip|7z|rar)$'
```

最后一条命令应无输出。发布构建时还应检查 `release/` 只作为 Release asset 使用，不要 `git add` 进普通提交。

## 诊断与安全提示

如果启动显示“首次启动需要本地角色”，这是公开版的版权保护设计，不是程序损坏。导入模型后点击“使用”会重新加载角色。若 PMX 转换失败，先确认 Blender 路径、模型目录中的纹理文件和读写权限；VRM 导入失败则检查文件是否为有效 VRM/GLB 2.0。软件只在本机保存导入角色和日志，不会自动上传模型。

## 许可

YachiyoDesk 软件源代码采用 [MIT License](LICENSE)。第三方运行库见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。八千代及任何其他角色资产不属于本软件许可证范围，必须遵守各自原作者许可；八千代具体条款见 [`characters/yachiyo/MODEL_LICENSE.txt`](characters/yachiyo/MODEL_LICENSE.txt)。

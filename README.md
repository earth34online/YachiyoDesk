# YachiyoDesk

YachiyoDesk 是一个 Windows 本地桌面伴侣：使用 Electron + Three.js + `@pixiv/three-vrm` 渲染 VRM 角色，提供透明桌面窗口、拖动、点击互动、平滑待机/行走、动作与对白、状态面板、角色切换，以及在本机把 PMX 转换成 VRM 后导入。

## 下载并运行

从 [Releases](https://github.com/earth34online/YachiyoDesk/releases) 下载最新版本：

- [便携版 Portable](https://github.com/earth34online/YachiyoDesk/releases/latest/download/YachiyoDesk-1.0.0-x64-Portable.exe)：下载后直接运行，不写入安装目录。
- [安装版 Setup](https://github.com/earth34online/YachiyoDesk/releases/latest/download/YachiyoDesk-1.0.0-x64-Setup.exe)：按向导安装，可创建桌面和开始菜单快捷方式。
- `SHA256SUMS.txt`：校验下载文件完整性。PowerShell 可运行 `Get-FileHash .\YachiyoDesk-1.0.0-x64-Portable.exe -Algorithm SHA256`。

首次公开版启动时不会内置八千代模型。请点击“打开角色库并导入”，导入你有权使用的 `.vrm`，或导入 `.pmx` 让本机转换器生成 VRM；之后在角色库中点击“使用”。模型会保存在 `%APPDATA%\YachiyoDesk\characters`，下次启动会自动使用已选择的角色。软件本身默认保持 35% 显示比例、透明置顶窗口和开机启动设置，可在设置面板中调整。

## 八千代模型：来源、署名和版权边界

仓库和 Release **不包含八千代的 VRM、PMX、纹理或模型压缩包**。本地随项目保存的 `characters/yachiyo/MODEL_LICENSE.txt` 明确规定“再配布：NG”，因此不把模型数据上传到 GitHub，避免让使用者或维护者违反原作者条款。

八千代模型请从原作者水色の描提供的页面获取，并以下载页面当前的条款为准：

- [VRoid Hub](https://hub.vroid.com/users/98041368)
- [ニコニ立体](https://3d.nicovideo.jp/users/134997762)
- [BowlRoll](https://bowlroll.net/user/1004051)
- [BOOTH](https://mizuirononeko.booth.pm)

使用时必须保留原作者署名“水色の描”。当前许可文件还限制暴力、R-18、法人/个人商用和再分发，并允许改编；原作及相关角色权利仍归各权利人所有。若下载页的最新许可与仓库中的副本不同，应遵守最新许可。请不要把下载后的模型、纹理或改造后的模型提交到本仓库、Release、网盘或其他公共渠道。

## 角色优先级与兼容性

1. **原作者提供、与本软件直接匹配的 VRM**：优先推荐，保留原始材质、表情、人体骨骼和 VRM SpringBone，动作与衣物物理质量最好。
2. **其他标准 VRM 1.0/0.x**：可通过“导入 VRM”使用。软件会读取 humanoid 骨骼并应用通用动作；缺失骨骼、非标准命名、没有 SpringBone 或表情的模型会自动降级，可能没有完整脚步、手掌朝向、视线或衣物摆动。
3. **PMX/PMD 本机转换**：通过“导入 PMX（自动转换）”调用本地 Blender 转换器。需要安装 Blender 4.x，并在设置或环境变量 `YACHIYO_BLENDER_PATH` 指向 `blender.exe`；转换会尽力映射人体骨骼、材质和物理，但 PMX 的非标准骨骼、刚体、Morph、复杂裙摆、特殊 toon 材质无法保证完全等价。转换后的结果存入用户数据目录，原 PMX 不会上传。

通用动作会根据模型能力自适应；八千代专属微调只在八千代 manifest 中启用，不会污染未来导入角色。任何第三方角色都应由使用者自行确认模型许可、二次创作规则和再分发限制。

## 给想自己修改的开发者

### 环境

- Windows 10/11
- Node.js 20+（推荐当前 LTS）和 npm
- 若需要 PMX 转换：Blender 4.x，并安装/配置 `YACHIYO_BLENDER_PATH`

### 获取源码并运行

```powershell
git clone https://github.com/earth34online/YachiyoDesk.git
cd YachiyoDesk
npm ci
npm run verify
npm run start
```

`npm run verify` 会执行 TypeScript 类型检查、Vitest 单元测试和 Vite 渲染器构建。开发调试可使用 `npm run electron:dev`（先另开终端运行 `npm run dev`）。

### 本地准备八千代或其他角色

不要把模型放进 Git。将你从原作者合法获取的 `model.vrm` 通过软件“角色库 → 导入 VRM”导入；或者使用 PMX 导入功能。开发者也可以在本地构建前将自己的模型放到 `characters/yachiyo/model.vrm`，但该文件会被 `.gitignore` 忽略，且不得提交或发布。公开构建故意不包含模型，首次运行的引导页就是预期行为。

### 构建发布包

```powershell
npm run dist:portable   # 便携版
npm run dist            # 便携版 + NSIS 安装版
```

构建产物在 `release/`。发布前请确认 `git ls-files` 中不存在 `.vrm/.pmx/.zip`、纹理、`node_modules`、`release` 或本地工具目录；大于 100 MiB 的安装包应作为 GitHub Release asset 上传，而不是普通 Git blob。发布说明应再次写明模型不随包分发、原作者来源和许可边界。

### 代码结构

- `electron/main.cjs`：主进程、透明窗口、托盘、设置持久化、角色库、VRM/PMX 导入 IPC。
- `electron/pmx-converter.cjs`、`converter/pmx_to_vrm.py`：调用 Blender 的本机 PMX→VRM 转换流程。
- `src/AvatarRuntime.ts`：Three.js/VRM 加载、相机、物理、渲染循环和性能自适应。
- `src/ProceduralAnimator.ts`：通用人体动作、走路步态、手掌/肘部约束和角色动作。
- `src/AppUI.ts`、`src/InteractionController.ts`：设置面板、角色管理、拖动和鼠标互动。
- `characters/yachiyo/character.json`：八千代行为和动作配置；模型文件刻意不在仓库中。

## 诊断与安全提示

如果启动显示“首次启动需要本地角色”，这是公开版的版权保护设计，不是程序损坏。导入模型后点击“使用”会重新加载角色。若 PMX 转换失败，先确认 Blender 路径、模型目录中的纹理文件和读写权限；VRM 导入失败则检查文件是否为有效 VRM/GLB 2.0。软件只在本机保存导入角色和日志，不会自动上传模型。

## 许可

YachiyoDesk 软件源代码采用 [MIT License](LICENSE)。第三方运行库见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。八千代及任何其他角色资产不属于本软件许可证范围，必须遵守各自原作者许可；八千代具体条款见 [`characters/yachiyo/MODEL_LICENSE.txt`](characters/yachiyo/MODEL_LICENSE.txt)。

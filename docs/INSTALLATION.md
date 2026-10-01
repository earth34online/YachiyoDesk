# 安装与角色导入指南

这份文档面向第一次使用 YachiyoDesk 的用户。若你只想快速运行，直接下载 [最新 Release](https://github.com/earth34online/YachiyoDesk/releases/latest) 即可；若你需要处理 PMX、排查材质或迁移数据，请继续阅读。

## 1. 选择构建版本

| 文件 | 适合人群 | 行为 |
| --- | --- | --- |
| `YachiyoDesk-*-x64-Setup.exe` | 长期使用 | 安装到指定目录，创建桌面/开始菜单快捷方式 |
| `YachiyoDesk-*-x64-Portable.exe` | 便携、测试、多版本并存 | 直接运行，不需要安装向导 |

两个版本功能相同，均为 64 位 Windows 构建。安装包和便携包都不携带八千代或其他角色模型。

下载后建议先校验 SHA-256：

```powershell
Get-FileHash .\YachiyoDesk-1.0.7-x64-Portable.exe -Algorithm SHA256
Get-FileHash .\YachiyoDesk-1.0.7-x64-Setup.exe -Algorithm SHA256
```

将输出与 Release 中的 `SHA256SUMS.txt` 对比。GitHub 的 `/releases/latest/download/...` 链接会始终指向最新正式 Release，适合脚本或收藏使用。

不同版本的哈希不同，请下载同一个 Release 附带的 `SHA256SUMS.txt` 对照，不要用旧版哈希校验新版文件。

如果 PowerShell 命令输出不同，不要运行该文件；重新从 Release 下载，或检查下载是否被代理、杀毒软件或浏览器中断。

## 2. 首次启动

公开版不含模型是有意设计：八千代模型许可禁止再分发，软件必须让使用者自己从原作者页面获取。首次启动会看到“首次启动需要本地角色”卡片：

1. 点击“打开角色库并导入”。
2. 选择“导入 VRM 角色”或“导入 PMX（自动转换）”。
3. 导入结束后，在角色列表对应卡片点击“使用”。
4. 程序重新载入并保存当前角色，下一次启动会继续使用它。

导入后的目录：

```text
%APPDATA%\YachiyoDesk\characters\<角色ID>\
  model.vrm
  character.json
  conversion-report.json   # 仅 PMX 转换角色可能存在
```

## 3. 导入 VRM

VRM 是推荐格式。将你有权使用的 VRM 文件直接交给导入按钮即可。程序会检查 GLB/VRM 2.0 文件头和文件大小，再复制到用户角色库；原始文件不会被移动或删除。

理想兼容条件：

- VRM 0.x 或 1.0 humanoid 骨骼完整；
- 左右手、前臂、脚、脚趾等骨骼名称和方向正确；
- 模型自带表情（BlendShape/Expression）；
- 头发、衣物带有 VRM SpringBone 时可获得更自然的摆动。

缺少某些能力时，YachiyoDesk 会使用通用动作并跳过不可用骨骼，不会因为一根缺失骨骼让整个角色崩溃。

## 4. 导入 PMX

PMX 需要本机 Blender 4.2 或更新的 4.x 版本，以及 **MMD Tools** 和 **VRM format** 两个扩展。公开安装包不捆绑 Blender 或扩展。已在本项目验证的组合是 Blender 4.5.13 LTS、MMD Tools 4.5.13、VRM format 4.5.0；其他版本需要另行验证。转换器会尝试映射人体骨骼、材质、纹理、Morph、刚体和 SpringBone；由于两种格式并非一一对应，复杂模型不保证完全等价。

### Blender 配置

1. 安装 Blender，并在 **Edit → Preferences → Get Extensions** 中从官方 `extensions.blender.org` 仓库安装 [MMD Tools](https://extensions.blender.org/add-ons/mmd-tools/) 和 [VRM format](https://extensions.blender.org/add-ons/vrm/)。离线安装可以使用菜单的 **Install from Disk**，但必须选择同一官方仓库作为安装目标，确保模块位于 `extensions/blender_org`；装到其他仓库或使用旧式 Add-on 目录不符合当前转换器契约。操作入口见 [Blender 4.5 扩展安装说明](https://docs.blender.org/manual/en/4.5/editors/preferences/extensions.html)。
2. 确认资源目录包含下面的结构（每个扩展目录都应有 `__init__.py` 与 `blender_manifest.toml`）：

```text
<资源目录>/
  extensions/blender_org/mmd_tools/
  extensions/blender_org/vrm/
```

3. 用环境变量明确指定 Blender 和资源目录。普通 Windows 安装通常使用以下目录；如果你使用其他版本或自定义路径，请替换为实际位置：

```powershell
$env:YACHIYO_BLENDER_PATH = 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe'
$env:YACHIYO_BLENDER_USER_RESOURCES = Join-Path $env:APPDATA 'Blender Foundation\Blender\4.5'
```

资源目录含义见 [Blender 目录布局说明](https://docs.blender.org/manual/en/4.5/advanced/blender_directory_layout.html)。转换子进程通过 `BLENDER_USER_RESOURCES` 使用上述目录；不会向系统 Python 安装包。

确认命令：

```powershell
Test-Path $env:YACHIYO_BLENDER_PATH
& $env:YACHIYO_BLENDER_PATH --version
Test-Path (Join-Path $env:YACHIYO_BLENDER_USER_RESOURCES 'extensions\blender_org\mmd_tools\__init__.py')
Test-Path (Join-Path $env:YACHIYO_BLENDER_USER_RESOURCES 'extensions\blender_org\vrm\__init__.py')
```

这些 `$env:` 设置只影响当前 PowerShell 及其子进程。请从同一终端启动 YachiyoDesk；如需通过桌面快捷方式长期启动，请在 Windows 用户环境变量中保存这两项，并重新启动应用。

未显式指定时，程序依次寻找工作区 `.tools`、便携目录附近的 `.tools` 和 `%ProgramFiles%\Blender Foundation\Blender 4.x\blender.exe`。资源优先使用相邻的 `blender-user` 隔离目录，否则使用匹配版本的 `%APPDATA%\Blender Foundation\Blender\4.x`。转换前会检查两个扩展，缺失时直接报告名称、实际资源目录和配置方法，不启动长时间转换。运行过程中扩展加载失败仍会记录在转换报告中。

### PMX 文件准备

请保持 PMX 与下列文件的相对位置不变：

- `.pmx` 主模型（当前版本不接受 `.pmd` 主模型）；
- PNG/JPG/TGA/BMP 纹理；
- `.sph`、`.spa` 球形贴图；
- 模型依赖的 toon 纹理或外部材质文件。

转换失败时，先把模型和纹理放入同一个临时目录，再重试。转换报告会记录骨骼映射、纹理数量、SpringBone 与警告信息。

导入时会检查蒙皮权重。明确的孤立缺权重顶点可自动修复；骨骼边界、没有足够邻居的顶点不会猜测修补。导入成功但还有风险时，程序会提示警告并给出 `conversion-report.json` 路径。可识别的原作者八千代 VRM/PMX 按文件哈希应用专属动作配置，其他模型始终走通用角色逻辑。运行中的网格接触只对可识别且规模在预算内的已转换 PMX 衣物开启，超预算会回退；这不是所有衣物零穿模的承诺。

### 转换后的质量边界

PMX 的非标准骨骼、复杂裙摆、特殊刚体链、Morph 驱动的脸部动画、外部 toon 贴图可能需要在 Blender 或 VRM 编辑器中二次修正。不要把转换结果视为原 PMX 的完美替代；请先在本机确认手掌朝向、脚步、衣物碰撞和表情，再长期使用。

## 5. 日常操作速查

| 操作 | 效果 |
| --- | --- |
| 左键按住角色 | 拖动桌面窗口，边缘会自动限制在屏幕内 |
| 单击角色 | 停止自主行走并触发头/身体/下半身互动 |
| 鼠标悬浮 | 显示快捷互动栏 |
| 右键 | 打开动作、状态和设置面板 |
| 滚轮（指向角色） | 调整显示比例 |
| 点击面板外部 | 关闭面板 |
| 托盘右键 | 打开设置、角色库、数据目录、重置姿态或退出 |

如果 15 秒没有触碰角色且“屏幕底部自主活动”开启，角色会恢复走路，并在走路之间穿插动作和对白。

## 6. 迁移与清理

备份角色库时复制：

```text
%APPDATA%\YachiyoDesk\characters
```

卸载安装版默认不会删除用户数据。删除角色前请先备份需要保留的 `model.vrm` 和转换报告。模型文件属于你从第三方获取的资产，不能因为它位于该目录就自动获得再分发权。

## 7. 常见问题

### 为什么启动时没有八千代？

公开版没有把八千代模型放入安装包。请从 [原作者页面](../README.md#八千代模型来源署名和版权边界) 合法获取，再用 VRM 导入。

### 为什么 PMX 转换按钮提示找不到 Blender？

设置 `YACHIYO_BLENDER_PATH`，确认路径指向真正的 `blender.exe`，而不是 Blender 安装目录。转换器不需要把 Blender 打包进 GitHub Release。

### 为什么某些 VRM 的手、脚或衣服动作不完整？

程序只能驱动模型实际提供并正确映射的 humanoid 骨骼与 SpringBone。缺失或方向错误的骨骼会触发安全降级；这不是通过复制八千代专属参数就能修复的，需要在模型源文件中修正。

### 为什么安装包体积约 100 MB？

Electron 运行时、Chromium、Three.js 依赖和 PMX 转换代码都在包内；模型没有打进包。安装包作为 Release asset 发布，而不是普通 Git 文件。

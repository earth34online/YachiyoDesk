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
Get-FileHash .\YachiyoDesk-1.0.1-x64-Portable.exe -Algorithm SHA256
Get-FileHash .\YachiyoDesk-1.0.1-x64-Setup.exe -Algorithm SHA256
```

将输出与 Release 中的 `SHA256SUMS.txt` 对比。GitHub 的 `/releases/latest/download/...` 链接会始终指向最新正式 Release，适合脚本或收藏使用。

当前 `v1.0.1` 的校验值如下；任何时候都应以对应 Release 中的 `SHA256SUMS.txt` 为准。

```text
Portable  D9DE498E9D51A0D05E95430AE92BDA96DC7E999CE8975689AE99A70A17E8E501
Setup     F31EC542C04720A773EDDBE300F67EBEB45074E9C0501DC3D3D52E9D18297D58
```

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

## 4. 导入 PMX/PMD

PMX 需要本机 Blender 4.x。转换器会尝试映射人体骨骼、材质、纹理、Morph、刚体和 SpringBone；由于 PMX 与 VRM 的骨骼、toon 材质和物理模型并非一一对应，复杂模型不保证完全等价。

### Blender 配置

优先用环境变量明确指定 Blender：

```powershell
$env:YACHIYO_BLENDER_PATH = 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe'
```

也可以将 Blender 放在转换器支持的标准安装位置。确认命令：

```powershell
Test-Path $env:YACHIYO_BLENDER_PATH
& $env:YACHIYO_BLENDER_PATH --version
```

### PMX 文件准备

请保持 PMX 与下列文件的相对位置不变：

- `.pmx` / `.pmd` 主模型；
- PNG/JPG/TGA/BMP 纹理；
- `.sph`、`.spa` 球形贴图；
- 模型依赖的 toon 纹理或外部材质文件。

转换失败时，先把模型和纹理放入同一个临时目录，再重试。转换报告会记录骨骼映射、纹理数量、SpringBone 与警告信息。

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

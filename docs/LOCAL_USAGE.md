# YachiyoDesk 1.0.9 本机使用说明

更新日期：2026-10-20。1.x 收官版，构建及验证状态见 [本轮记录](RELEASE_20261020.md)。

## 启动

双击桌面的 `YachiyoDesk - 八千代` 快捷方式，或直接运行：

```text
F:\create\YachiyoDesk\release\win-unpacked\YachiyoDesk.exe
```

本机桌面构建保留原有八千代模型。公开发布构建使用同一套核心程序，首次启动通过角色库导入本地模型。

公开版成品位于：

```text
F:\create\YachiyoDesk-public\release\YachiyoDesk-1.0.9-x64-Portable.exe
F:\create\YachiyoDesk-public\release\YachiyoDesk-1.0.9-x64-Setup.exe
```

## 常用操作

| 操作 | 效果 |
|---|---|
| 左键按住角色 | 拖动桌面窗口 |
| 单击角色 | 中断行走并触发互动 |
| Shift＋左键，或中键拖动 | 旋转角色 |
| 鼠标滚轮 | 调整角色显示比例 |
| 右键角色 | 打开动作和设置入口 |
| Ctrl＋0 | 恢复默认朝向与 35% 显示比例 |
| 托盘右键 | 显示角色、打开设置、角色库或数据目录 |

设置面板提供常用参数、动作、陪伴、角色管理和性能信息。角色比例分别保存；专注计时和宠物状态也按本地配置持续保存。

开启自主活动后，角色沿屏幕底部行走并穿插动作。点击、拖动或操作设置时会暂停行走；闲置 15 秒后恢复活动。开机启动、位置锁定、置顶、物理和鼠标穿透均可在设置中调整。

## 导入角色和数据

在角色库中选择“导入 VRM”或“导入 PMX”，完成后点击角色卡上的“使用”。PMX 转换需要本机 Blender 及 MMD Tools、VRM format 扩展。

本版导入通用 PMX 时会保留原始刚体与关节所需的数据。旧导入若提示缺少原始物理数据，请从完整原始目录重新导入 PMX；模型和贴图留在本机。八千代继续使用已有专用配置。

通过托盘或角色菜单中的“打开配置与日志目录”查看实际用户数据目录。正常使用的角色、设置、陪伴状态和日志保存在该目录；开发实验目录与它分开。

## 项目资料

本机项目的 `docs` 目录保存当前安装指南、架构、需求、维护规则和版本说明。公开源码位于 `F:\create\YachiyoDesk-public`，桌面构建位于 `F:\create\YachiyoDesk`；共享内容通过 `npm run sync:local` 同步。

本轮诊断与画面证据保存在 `F:\create\YachiyoDesk-public\artifacts\airi-review-20261020`，历史 1.0.8 交付证据保留在 `artifacts\release-final-20261006`。

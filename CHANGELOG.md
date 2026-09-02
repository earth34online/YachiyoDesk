# 变更记录

项目遵循“先保证现有角色可运行，再扩展通用能力”的发布策略。

## [1.0.0] - 2026-09-02

### Added

- Electron + Three.js 透明桌面窗口；
- VRM 角色导入、切换和本地角色库；
- PMX/PMD 通过 Blender 本机转换为 VRM；
- 通用 VRM humanoid 动作、步态、手掌/肘部约束；
- 自主行走、动作插播、对白、宠物状态和焦点计时；
- 拖动、边界限制、鼠标悬浮快捷栏、右键设置面板；
- Ultra/High/Balanced 画质和自适应像素倍率；
- 首次启动无模型引导，避免打包受限制角色资产；
- Windows x64 Portable 和 NSIS Setup Release。

### Licensing

- YachiyoDesk 源代码采用 MIT License；
- 八千代模型不随仓库或 Release 分发；
- 八千代来源、署名和“再配布：NG”条款记录在 `characters/yachiyo/MODEL_LICENSE.txt`。

## 后续方向

- 增加更多不依赖模型专属骨骼的动作；
- 改善转换器对非标准 PMX 骨骼和裙摆物理的报告；
- 增加可选的自动化构建与 Release 校验工作流；
- 为通用角色 manifest 提供更完整的示例模板。

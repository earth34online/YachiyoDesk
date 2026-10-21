# 架构与扩展点

本文对应 2.0 开发版，维护日期为 2026-10-21；1.x 交付记录保留在 [版本记录](RELEASE_20261020.md)，2.0 验收见 [开发记录](DEVELOPMENT_2.0.md)。

YachiyoDesk 将“桌面窗口控制”“角色资产管理”“VRM 运行时”“动作系统”和“UI”分层。这样八千代的特调参数可以留在角色 manifest 中，未来导入的任意 VRM/PMX 仍然走通用标准。

2026-10-21：`jointDynamics.ts` 保留打断时的关节速度，`armContactSurface.ts` 和 `headContactSurface.ts` 依据衣物、头发及手指真实表面求解避让。`skinSeams.ts` 修复有严格绑定共识的分离接缝；`skinGradients.ts` 只在已确认损坏网格上按原骨骼支持域、非负和单位和约束求解蒙皮梯度。刚性锚点、完好衣物、UV、几何、褶皱和原文件保持。

原始 PMX 由导入指纹，或新建且绑定源文件/模型双哈希的单独验证记录核实；原生 Ammo 与 VRM SpringBone 不重复驱动骨骼。`springArmContacts.ts` 仅在通用转换回退中复用/对齐已有手臂形状。`automaticSpringContacts.ts` 只响应导入时确认缺失的配置：识别身体覆盖、在非动态可见表面内拟合胶囊，并约束静止发梢。已有配置、八千代、缺动态链和歧义来源不被自动改写。`contact-configuration.cjs` 检查导入状态与有限参数，用户 API 计划只写暂存副本、清除加载确认并重新预览。取消与迟到结果按代际及独立请求控制器隔离。证据见 [审查记录](REVIEW_20261021.md)。

## 分层关系

```mermaid
flowchart TB
    UI[src/AppUI.ts<br/>设置、角色库、对白] --> Bridge[electron/preload.cjs<br/>安全 IPC 桥]
    Input[src/InteractionController.ts<br/>拖动、点击、滚轮] --> Runtime[src/AvatarRuntime.ts<br/>Three.js/VRM 渲染]
    Bridge --> Main[electron/main.cjs<br/>窗口、托盘、配置、角色库]
    Main --> Store[electron/settings.cjs<br/>本地持久化]
    Main --> Import[VRM 导入 / PMX 转换]
    Import --> UserData[%APPDATA%/YachiyoDesk/characters]
    Runtime --> Animator[src/ProceduralAnimator.ts<br/>通用人体动作]
    Runtime --> Spring[VRM SpringBone<br/>头发与衣物物理]
    Runtime --> PMX[src/pmxPhysics.ts<br/>原始 PMX 刚体与关节]
    Animator --> Profile[character.json motionProfile<br/>通用标准 + 角色特调]
```

## 主进程

`electron/main.cjs` 负责：

- 创建透明、无边框、置顶的窗口；
- 约束窗口位置不超过当前显示器边界；
- 处理拖动、自主移动、点击中断和 15 秒恢复；
- 保存设置、焦点计时和宠物状态；
- 扫描内置角色与 `%APPDATA%` 下的用户角色；
- 校验 VRM，调用 Blender 完成 PMX→VRM；
- 通过 tray/menu 向 renderer 发送动作和设置命令。

模型原文件不上传。AI 修复仅在用户同意后，将界面列出的文件名、节点和诊断发送到使用者配置的接口；可选生成贴图另需明确授权。`appasset://` 读取打包资源或有效导入票据下的模型预览，`user-characters://` 只读取经过路径校验的用户角色目录。

`electron/companion-host.cjs` 统一校验调用来源并协调连接、会话、动作收藏、快照和导入预览。密钥由 Windows `safeStorage` 加密，网络请求和工具执行留在主进程；renderer 不读取密钥。`ai-service.cjs` 捕获每次请求的角色、模型和会话版本，取消、角色切换及关闭窗口会中止请求。语音只在一次录音获得同意后开放麦克风，停止即释放；图片和画面先预览，再发送。

导入先写入隐藏暂存目录，由独立 worker 执行 glTF 结构检查。用户看到真实运行时预览并确认后，才移入角色库。AI 只能改写已有骨骼映射、重映射清单内贴图或生成已获准的贴图；模型返回的代码、命令和任意路径不执行。处理规则随程序分发于 `skills/avatar-import-repair`。

`src/MotionPlayer.ts` 使用官方 VRMA 插件重定向本地动作，按照 AIRI 的方法将根位置轨道锚定到当前模型的局部髋部原位。切换与停止使用连续过渡，物理在最终姿态之后更新。可选自然待机仅用于通用角色，八千代原生动作保持独立。PMX 绑定桥区分动作控制的人体骨骼与动态刚体；物理回写不累积人体缩放，也不把刚体矩阵误差当作衣物尺寸变化。

## Renderer 与 VRM 运行时

`src/AvatarRuntime.ts` 负责：

1. 创建透明 WebGLRenderer 和灯光；
2. 使用 `GLTFLoader + VRMLoaderPlugin` 读取 VRM；
3. 清理不必要顶点；只对原生 VRM 合并骨骼，已转换 PMX 保留原始蒙皮/骨架对应关系；
4. 计算模型高度、相机距离、脚底锚点和点击碰撞网格；
5. 将角色 motion profile 应用到手掌、肘部、步态和 SpringBone；
6. 每帧更新表情、视线、动作、物理和性能统计；
7. 对有可核验原始文件的通用 PMX，使用 `src/pmxPhysics.ts` 桥接源骨架、刚体和关节；未接入原始物理时保留已有 VRM SpringBone 与有界网格接触兼容路径；
8. 在掉帧时降低像素倍率，不替换原始模型纹理。

没有模型时，runtime 不会尝试加载空 URL，而是触发首次导入引导；导入角色并切换后，窗口重新加载正常运行时。

## 动作系统

`src/ProceduralAnimator.ts` 是通用动作层。动作先构造标准人体姿态，再由 `motionProfile` 调整：

- `walk`：步频、步幅、膝盖抬升、髋部起伏、手臂摆动；
- `handPose`：左右臂轴、掌心符号、手腕幅度、肘部弯曲；
- `legPose`：腿部弯曲方向和下蹲幅度；
- `springBone`：长发、裙摆、衣物关节筛选及阻尼；
- `behavior`：自主活动动作权重和间隔。

通用 profile 是所有导入角色的安全基础；内置八千代使用 `characters/yachiyo/character.json` 的 `yachiyo-long-garment-v1`。通过 UI 导入时，`electron/recommended-model.cjs` 只对已验证的原作者 VRM/PMX 文件哈希启用对应的八千代专用 profile；原作者 PMX 仍保留 PMX 手腕/腿部坐标系补偿。其他文件无论名称是否包含“八千代”，都使用通用 profile。

PMX 转换在 `converter/skin_binding.py` 审核骨骼权重，仅修补相邻权重归属明确的孤立空洞；复杂边界记录警告。`conversion-report.json` 保留材质、纹理、骨骼、蒙皮和服装物理诊断。`garmentContact.ts` 处理的是运行时可识别衣物与身体的局部接触，不是完整的布料自碰撞或衣物层间模拟；不能据此宣称任意模型零穿模。

## 成品中的衣物接触实现

1.0.9 优先保留通用 PMX 原生的刚体、关节、碰撞分组和约束。VRM 继续拥有渲染、表情和人体动作；不可见的 PMX 实例只计算物理，不加载第二套纹理或网格。按绑定位置映射骨骼，物理与视角/缩放分开，并避免与 VRM SpringBone 重复驱动。新旧路径互斥，八千代保持原配置；完整适配依据见 [AIRI 审查记录](AIRI_REVIEW_20261020.md)。

`src/contactSkinning.ts` 采样当前骨骼、绑定矩阵和 Morph 的 CPU 蒙皮结果；`src/bodyContactEnvelope.ts` 提供身体支撑几何；`src/garmentContact.ts` 使用身体三角网格查询并输出保持原材质与 UV 的衣物副本。

`src/garmentIntegrity.ts` 在显示前检查顶点修正幅度、固定点、边长和三角面面积。允许的修正比例取从原始蒙皮开始的连续区间；多个面的约束共同收紧该区间，最终再次核验几何。BVH 查询返回结果还会确认实际距离，避免远处叶节点成为接触。

通用骨骼与已验证八千代的专属 profile 分开选择，角色 manifest 和原始资产由各自导入流程维护。测试服装的名称、材质名称或 ID 不参与物理参数选择。

## 两版同步与文档维护

公开源码是共享实现的维护入口。`scripts/sync-local.cjs` 同步源码、测试、转换器、依赖、公共脚本及文档，同时保留桌面项目的本地角色和资产准备脚本。

同步后执行两份项目的 `npm run verify`；打包后再核对实际程序版本、共享核心文件与角色哈希。详细操作见 [维护指南](MAINTENANCE.md)。

## 角色 manifest

最小角色目录：

```text
my-character/
  model.vrm
  character.json
```

最小 `character.json`：

```json
{
  "id": "my-character",
  "displayName": "我的角色",
  "creator": "原作者名称",
  "sourceFileName": "my-character.vrm",
  "model": "model.vrm",
  "credit": "模型署名",
  "messages": {
    "greet": ["你好！"]
  },
  "behavior": {
    "minIntervalSeconds": 6,
    "maxIntervalSeconds": 12,
    "actions": [{ "action": "walk", "weight": 40 }]
  }
}
```

实际导入时程序会补全缺失字段、限制动作集合、校验角色 ID，并为没有专属动作 profile 的角色选择通用标准。

## 扩展建议

- 新增通用动作：修改 `ReactionName`、动画姿态和 UI 动作列表，并补充测试；
- 新增角色：优先通过 UI 导入，不要把模型提交到仓库；
- 新增设置：在 `types.ts`、`settings.cjs`、preload、UI 和持久化测试中同步更新；
- 调整 PMX 映射：修改 `converter/pmx_to_vrm.py`，不要在 renderer 内写只适用于某一个模型的硬编码；
- 改进性能：优先测量帧耗时、draw call 和纹理数量，避免无证据地降低模型质量。

## 2026-10-21 桌面接触功能

新增主进程 DesktopContacts 状态机和只读 WindowSurfaces 辅助进程，输出窗口矩形转 DIP，扣除被遮挡顶边并维护双脚支撑范围。renderer DesktopContactPose 在原动画之后、humanoid 与衣发物理之前做骨盆/整腿 IK 和近边手势。窗口位置与脚底目标来自同一支撑状态，保留原网格、蒙皮与专用角色路径。PowerShell 文件作为 extraResources 分发，避免外部进程读取 ASAR。

详见 [桌面接触功能与验收](DESKTOP_CONTACTS_20261021.md)。

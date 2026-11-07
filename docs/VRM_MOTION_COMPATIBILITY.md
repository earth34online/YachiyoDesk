# 原生 VRM 动作兼容性

2026-11-06 从已发布的 `v2.0.0-beta.1` 固定基线开展对照。样例、用户角色和隔离构建在本地独立目录中保管。已发布版本的验证范围见 [固定基线](BASELINE_20261023.md)。

| 对照资产 | 覆盖范围 |
|---|---|
| [AvatarSample_B · VRoid Project / pixiv](https://github.com/pixiv/ChatVRM/blob/b542aa00e19dccf9fc48ba340cf7eee011d2329a/public/AvatarSample_B.vrm) | 原生 VRM 1.0，长发、长袖、短裙，内置 28 个摇摆骨骼碰撞体 |
| [Seed-san · VirtualCast, Inc.](https://github.com/vrm-c/vrm-specification/tree/94e82dd346fa6cf0337c4421728640e5252dd38e/samples/Seed-san) | 原生 VRM 1.0，内置 8 个碰撞体及 23 个节点约束，含随手臂联动的机械附件 |
| 本地海梦校服 | PMX 转换 VRM 与有来源关联的原始 PMX 物理路径 |

两份官方原生 VRM 在固定版绑定姿势中正常展开，但进入程序待机后手臂向上，伸展和欢呼向下。同一输入在程序切换姿势时反向，根因是程序曲线与标准化骨架的抬臂方向相反。修复在通用原生 VRM 上按标准化肩肘的横向骨段定向，沿用已有曲线及蒙皮、碰撞配置。PMX 转换和八千代继续使用其各自配置。

[AIRI 的动作实现](https://github.com/moeru-ai/airi/blob/63f91d82fe9945bfcb6bf0318eba823c1d591d61/packages/stage-ui-three/src/composables/vrm/animation.ts)调用本项目已使用的 `createVRMAnimationClip`，适用于 VRMA 文件。本次修复涉及程序生成的动作曲线，由同一个 three-vrm 标准化骨架提供基准。[AIRI 的模型初始化](https://github.com/moeru-ai/airi/blob/63f91d82fe9945bfcb6bf0318eba823c1d591d61/packages/stage-ui-three/src/composables/vrm/core.ts)保留原生摇摆骨骼，计算包围盒时排除碰撞辅助节点。该过滤不处理衣服网格的交叉。

两份样例的使用遵循文件内 VRM Public License 1.0 配置及作者条款。AvatarSample_B 另遵循 [VRoid 官方样例条款](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z)。样例仅用于本地对照。

## 正式导入与衣物复核

两份官方样例均经角色库文件选择、结构检查、真实预览、确认入库和切换使用。导入前后文件 SHA-256 一致，导入报告保留原生碰撞。隔离环境只替代文件选择器的返回路径，使用正常预览和确认入口。样例的可见效果支持原生 VRM 路径在抽样动作中的兼容性。既有 PMX 服装还受转换结果、源蒙皮、原始物理配置及动作影响，不能由两个原生 VRM 样例单独归因。

AvatarSample_B 的下蹲正面一度被误判为大腿穿裙。逐帧提取实际蒙皮的身体和下装三角面后，待机与下蹲都只在腰线附近检测到交线，原先指出的大腿区域未出现该交线。以同样动作切换到 three-vrm 原生更新也保留裙摆上浮的外观。本轮没有依据这个外观修改裙摆。

## 动作与运行修复

- 待机以肩肘骨段和重力确定下垂方向，按站姿表面的实测间隙设置最小外展。待机不重求肘腕，也不对可选 VRMA 自然待机追加手臂避让。
- 亮掌动作从手指骨估计掌面和手掌纵轴，沿纵轴转到角色前方。待机原生 VRM 腕关节保持模型的前臂对齐，避免额外横向偏转。缺少可用指骨时沿用原姿势配置。
- 原生 VRM 鞠躬按模型前向校准俯仰，下蹲使用休息手臂方向作为起点，避免双臂展开至绑定姿势。转换配置由格式能力区分，没有按喜多川、模型文件名或衣装选择动作。
- 隔离验证观察到 WebGL2 初始化失败时界面停留在加载状态。初始化现在进入现有错误提示和重新载入入口，错误同步记录到主进程。故障注入已观察到错误界面及日志，隔离桌面的错误界面截图捕获返回 UnknownVizError。


## 2026-11-07 隔离复核

- 同一源码构建对两份正式入库样例各采集 18 个反应动作，以及待机、原生行走和拖动姿势。另有挥手、伸展的起始、中段、后段及回收侧面帧。每个样例保存 31 张有效画面，含正式导入预览。
- 抽样正面可见鞠躬向前，下蹲没有回到 T 字展开。AvatarSample_B 的打招呼和伸展中段，采样掌面法向由朝后改为朝前。待机与袖口的实拍画面供用户复核。
- 两树各自通过类型检查和构建，主 renderer 的 SHA-256 一致。隔离打包程序通过首次启动和 AvatarSample_B 的四个聚焦动作。日常应用及 Release 保持固定版。

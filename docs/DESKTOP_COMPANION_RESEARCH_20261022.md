# 桌宠项目功能调研与适配方案

调研于 2026-10-21 至 22 日完成。先按用户授权把已验收版本推送到 `feat/2.0-companion`，回退点为 [1cc9620](https://github.com/earth34online/YachiyoDesk/commit/1cc9620c93405792610a259aa7f86c1d5be18d74)。下文是功能评估，不能当作已接入清单；本轮实际代码修复见 [性能记录](PERFORMANCE_20261022.md)。

## 选择与证据范围

通过 GitHub 仓库搜索及官方 API 核对热度、默认分支、提交、README 和许可，再查看与适配有关的实际源文件。星数取 10 月 21 日 API 快照，是选样依据，不是完整排名，也不代表功能质量或许可兼容。Desktop Mate 按用户上下文对应其 Steam 官方产品；它和 Mate Engine 是两个项目。

| 项目 | 星数快照 | 重点能力 | 核对提交 |
|---|---:|---|---|
| [AIRI](https://github.com/moeru-ai/airi) | 50,549 | 语音/视觉陪伴、角色表现、游戏连接、工具桥接 | `747d4f68aa42180671de3071fb78d5e6129433bd` |
| [BongoCat](https://github.com/ayangweb/BongoCat) | 24,065 | 键鼠/手柄输入与角色即时响应、自定义 Live2D | `30d0c34f557a76e7f265befa94e71704c813f8a9` |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 14,227 | 免手持语音、打断、视觉、表情与语音联动 | `992309c0aa19845960228f880013d4685fde93b5` |
| [VPet](https://github.com/LorisYounger/VPet) | 7,007 | 成长/工作/物品、内容工坊、动画与代码扩展 | `4578ea931604121e59219e476468781b68f26c1d` |
| [Mate Engine](https://github.com/shinyflvre/Mate-Engine) | 3,794 | 自带 VRM、窗口/任务栏坐姿、舞蹈与多角色同步 | `2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4` |
| [OpenPets](https://github.com/OpenPetsHQ/openpets) | 1,314 | 插件平台、显式权限、本地编程任务通知 | `5290e133596ee2f4f84f398d6669bb405b2b8824` |
| [Desktop Mate](https://store.steampowered.com/app/3301060/Desktop_Mate/) | 不适用 | 窗口坐姿、鼠标玩耍、摸头、闹钟与游戏联动 | 官方公开行为；不读取专有源码 |

Mate Engine 的比较表带有作者自己的产品比较和历史版本，不能据此认定其他产品没有某功能。Desktop Mate 的能力以其官方页面为准；不复制它的 DLC、模型、动画或反编译结果。

## 当前已有能力，避免重复包装

本项目已有五类用户 API、流式聊天、可管理记忆、按次录音与朗读、手动图片/屏幕发送、表情和动作工具、VRMA 动作收藏、创作室、宠物状态、专注/休息提醒，以及三类桌面接触。

目前应用窗口接触是双脚站立支撑，窗口移动会跟随，失去支撑会下落；**还没有窗口坐姿、垂腿或攀爬**。目前语音是录音、编辑后发送和可选朗读，**还不是持续对话、流式语音或自动语音打断**。可管理记忆不是未经确认的自动长期记忆。上述区别决定哪些值得新增。

## AIRI：可以借鉴的方法与实际前提

实际查看以下文件，路径均位于上述固定提交：

- [`packages/core-agent/src/voice/controller.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/core-agent/src/voice/controller.ts)：按回复轮次控制打断，区分播放静音完成与打断事件持久化完成；关闭时取消输入和响应。
- [`voice/output/response.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/core-agent/src/voice/output/response.ts)：文本分段、异步合成/播放队列、AbortSignal 与播放回执，避免上一轮剩余语音串入下一轮。
- [`voice-input-transcription-chain.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/stage-ui/src/composables/audio/voice-input-transcription-chain.ts)：识别任务串行与监听会话代际失效；不是一个简单的“把麦克风常开”开关。
- [`voice-input-suppression.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/apps/stage-tamagotchi/src/renderer/utils/voice-input-suppression.ts)：桌面输入部分在助手发声及尾音期间抑制输入。因此不能声称当前所有 AIRI 客户端路径都实现了扬声器条件下的无缝双向打断。
- [`use-chat-vision.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/stage-ui/src/composables/vision/use-chat-vision.ts)：区分聊天模型能直接看图和需独立视觉模型描述的路径。
- [`vision-read-queue.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/stage-ui/src/composables/vision/vision-read-queue.ts)：按 provider 控制并发并响应取消；源码明确说明多个窗口仍各自排队，不能直接当成全局限流方案。
- [`mcp-tool-bridge.ts`](https://github.com/moeru-ai/airi/blob/747d4f68aa42180671de3071fb78d5e6129433bd/packages/stage-ui/src/stores/mcp-tool-bridge.ts)：renderer 使用受控桥访问工具，并非把 Node 或任意电脑操作权限交给模型。

AIRI 的 README 将 Factorio 标为有 PoC 的 WIP，Helldivers 2 与 Memory Alaya 仍未完成。游戏连接分别依赖游戏服务、机器人/协议适配，不是对任意游戏通用的即插即用陪玩。当前浏览器本地推理也不能直接推断为所有客户端均已具备。

本项目此前已经参照 AIRI 的 VRMA 重定向、局部髋部锚定、最终姿态后更新物理，并使用同源 three-mmd 原始 PMX/Ammo 组件。AIRI 没有被本轮核实为“给任意衣物自动生成完整布料并保证不穿模”的通用解法；新功能继续保留真实原始物理及衣物结构。

## Desktop Mate / Mate Engine：更丰富的身体交互

[Desktop Mate 官方页面](https://store.steampowered.com/app/3301060/Desktop_Mate/)明确介绍窗口坐姿、鼠标玩耍、摸头、闹钟和游戏联动。我们已有摸头、计时和基础接触，最值得补的是有连续过渡的身体交互。

Mate Engine 源码提供了更具体的实现参照：

- [`AvatarWindowHandler.cs`](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarWindowHandler.cs)：窗口枚举与缓存、拖动停留后吸附、坐姿互斥状态、遮挡/最小化/全屏过滤、骨盆/腿/脚参考及目标窗口平移跟随。它使用 Unity Animator 坐姿动画、相机投影和窗口遮挡平面；不能只把 Win32 枚举函数复制过来就得到自然坐姿。
- [`AvatarDancePlayer.cs`](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarDancePlayer.cs)：自定义舞蹈播放；资源和 Unity 动画控制器依赖需要单独适配。
- [`AvatarDanceSync.cs`](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarDanceSync.cs)：本机多实例领导者选举、同步时间及音频控制。这是同步舞蹈的证据，不能当成已经证明任意系统音乐都能生成正确舞蹈。
- [`AvatarDanceSafetyZone.cs`](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/Assets/MATE%20ENGINE%20-%20Scripts/AvatarHandlers/AvatarDanceSafetyZone.cs)：舞蹈越出可视范围时平移相机/窗口。适配时应移动观察区域或舞台，不能缩小动作幅度掩盖越界。

适配应独立编写通用坐姿/垂腿状态，按真实骨盆、腿长、窗口顶边与可达性求解，从站立/拖动过渡，窗口失去支撑时恢复下落。四套服装和当前人物需验证坐下、垂腿、起身及中断，八千代独立回归；只有固定坐姿欧拉角不足以交付。裙装完整性未通过前不能默认给所有人物强制坐下。

## 建议优先级与实现路径

以下为工程评估，未在本轮直接启用新功能。评价同时考虑体验价值、当前架构、许可、质量与验证成本。

| 顺序 | 候选能力 | 对现有产品的增量 | 可复现路径与前提 | 验收重点 |
|---|---|---|---|---|
| 1 | 窗口坐姿、垂腿、坐下/起身的完整交互 | 从“站在边缘”变成真正使用桌面空间 | 独立扩展接触状态机与通用 IK；参考 Desktop Mate 行为和 Mate Engine 的状态/遮挡思路；需要有权使用的动作或程序求解 | 衣服不裂/不膨胀，骨盆支撑正确，窗口移动/最小化/遮挡/多屏/打断一致 |
| 2 | 连续语音对话、逐句朗读与可打断 | 免去反复录音、等待完整回复再听 | AIRI 的轮次、取消、队列和播放回执；参考 Open-LLM-VTuber 的实际打断能力；先检查用户服务的流式能力，适配非流式接口 | 麦克风明确开启/关闭，扬声器回声、说话抢占、已播文本与记忆一致、切换/退出无残留 |
| 3 | 配合正在看的内容交谈 | 从手动发截图变成有上下文的陪伴 | 保留手动模式；用户显式选择窗口、内容和会话时段，按变化采样与预算控制；视觉模型能力分流 | 不后台默读其他窗口，遮挡/敏感区域处理，停止即取消，费用和发送范围可理解 |
| 4 | 音乐与舞蹈舞台 | 动作库变成可以播放完整作品的体验 | 先做合法本地音轨与 VRMA 的统一时钟/暂停/拖动进度；需要 VMD 时单独校验重定向；节拍自动编舞作为后续独立能力 | 音画同步、完整动作不出框、衣发稳定、音乐/动作许可；不混同节拍反应和生成编舞 |
| 5 | 可扩展内容包与有限权限插件 | 从开发者硬编码变成用户可持续增加内容 | 学习 VPet 的内容组织、OpenPets 的 manifest/权限/隔离；先用声明式动作/对白/道具包，再评估代码插件 | 版本兼容、卸载和回滚、资源释放、权限明确、无任意主进程代码执行 |
| 6 | 编程/下载/构建任务状态陪伴 | 角色响应真实任务完成、失败和等待 | 参考 OpenPets，本机认证事件桥只接任务 ID、状态和去敏后的摘要；不自动注入未知工具或读取日志 | 事件去重、失联恢复、安静时段，气泡不暴露提示词/路径/密钥 |
| 7 | 输入节奏互动 | 键鼠/手柄操作时角色做自然反馈 | 参考 BongoCat，只传需要的按下/松开或节奏，不记录输入文本；通用腕/肘动作叠加 | 全局监听明确开关，输入设备释放、低延迟、不抢焦点、不影响游戏输入 |
| 8 | 有意义的养成与物品 | 宠物数值影响生活行为而非只显示数字 | 参考 VPet 的工作/休息/物品循环，独立制作内容、动画与经济规则 | 不强制打扰，不用重复点击刷状态，离线时间/系统时钟变化可恢复 |

建议先做第 1、2 项：它们直接对应当前 3D 桌宠的空间存在感和交流体验。第 4 项适合作为独立舞台，先完成单角色质量；多角色实时 PMX 和同步舞蹈成本更高，不能承诺无额外开销。此处优先级不是用户已批准的新增开发清单。

## 许可与代码使用边界

| 来源 | 已核对的条件 | 本项目处理 |
|---|---|---|
| AIRI | MIT，复制代码须保留版权与许可；动作/模型/外部服务另核对 | 现有改编与 idle 动作已有署名；本轮新增调研未复制其实现 |
| Open-LLM-VTuber | 根 LICENSE 明确 MIT，Live2D 示例模型另有许可 | 可研究语音设计；不能将示例模型随本项目发布 |
| BongoCat | Apache-2.0；模型及 Cubism 依赖另核对 | 先学习输入到表现的组织，不把 Live2D 依赖带入 VRM 项目 |
| VPet | 软件 Apache-2.0，原动画有独立署名、传播和商用条款 | 独立制作本项目内容，不复制动画/物品素材 |
| OpenPets | MIT；插件、模型与外部工具仍分别核对 | 参考权限与事件设计，实际接入前核对具体 SDK 依赖 |
| Mate Engine | README 标注混合 AGPL 与 MateProv2；根文件有自定义 Pro v2.1、完整源码同许可和分发/商业限制，资产另保留版权 | 不把整个仓库当作宽松开源，不直接复制进当前 MIT 项目；需要复用具体代码时先厘清文件许可并取得适用授权，否则独立实现公开行为 |
| Desktop Mate | 专有产品，官方 EULA 与各角色权利分别适用 | 只读参考公开行为，不复制程序、动作、DLC 或资源 |

原文依据：[Mate Engine 许可](https://github.com/shinyflvre/Mate-Engine/blob/2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4/LICENSE.md)、[VPet 仓库与动画说明](https://github.com/LorisYounger/VPet/tree/4578ea931604121e59219e476468781b68f26c1d)、[Open-LLM-VTuber 许可](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/992309c0aa19845960228f880013d4685fde93b5/LICENSE)。不为获得一个功能而未经说明更改整个项目的许可和分发方式。

## 本轮结论

成熟项目最值得借鉴的是空间交互、持续交流、音画同步、内容生态与真实任务响应。随机加几个按钮或小玩法不能替代这些能力。本轮先解决当前运行卡顿、保留全部质量与已有功能，再由上述具体方案决定后续产品范围。

本机原始证据位于 `F:/create/artifacts/desktop-research-performance-20261021/references`，包含 API 元数据、固定提交树、README、许可和选读代码；仅用于审阅，不随软件分发。功能可行性为基于源码的工程判断，不冒充已经在本项目完成实机复现。

# 坐姿接触的开源实现复核

2026-11-07。用户指出第 19 与 25 项重复、坐姿掌腿穿模，并要求停止局部绕圈修正，优先参考实际开源代码。本文件记录已读实现及适配边界，不代表坐姿通过验收。beta.2 固定标签保留，经过本轮核对后按用户授权统一交付 beta.3。

| 原始实现 | 已核对内容 | 对当前问题的作用 |
|---|---|---|
| [AIRI animation.ts](https://github.com/moeru-ai/airi/blob/5673976c04bacf235009f24b42169a796c114b80/packages/stage-ui-three/src/composables/vrm/animation.ts) | 官方 VRMA Loader、createVRMAnimationClip、局部髋部轨道锚定，MIT | 延续已有播放管线；该文件没有掌腿接触解算，不声称复制它就能自动防止人体相交 |
| [three-vrm 官方实现](https://github.com/pixiv/three-vrm/blob/3caf7a21ee68f0d5dfa363ab3d577450bbf60136/packages/three-vrm-animation/src/createVRMAnimationClip.ts)与 [VRMA 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md) | 标准化骨骼旋转、髋部高度比例、目标节点映射；规范建议更高级重定向 | 旋转正确不意味着不同肢体比例下手仍接触同一位置，接触应单独定义目标 |
| [Three.js CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html) | 使用 SkinnedMesh、目标/效应器/骨链及混合权重，MIT | 是成熟的关节链求解参考；它不选择大腿表面接触点，不能靠替换 IK 名字修复错误目标 |
| [HVR IK self-parenting](https://github.com/hai-vr/hvr-ik#parenting-the-hand-effectors-to-the-avatar-using-self-parenting) | 手效应器相对身体/腿骨的位置、旋转及权重；Apache-2.0 | 将“手放在腿上”当作接触目标，而非无条件把穿入的手向上推。其作者明确标注开发中、极限扭转等问题，不整套移植，也不将其称为成熟高 star 成品 |
| [XR Animator](https://github.com/ButzYung/SystemAnimatorOnline/blob/master/readme.md#copyrightlicensecredits) | 原作者 readme：改编源码为 CC BY-NC-SA 4.0 | 可评估行为和公开说明；不将其受限实现直接复制到 MIT 项目，不为此擅改整个项目许可 |

当前问题已定位：接触 BVH 将 alpha=0、alphaCutoff=.5 的衣物透明区域当成实体。离线原始纹理和三角面验证中，三个实际探针先命中 y=.59127/.60194/.60718 的透明外套，其下可见皮肤为 y=.52932/.51546/.50925，产生 6.20–9.79 cm 假间隙。名称仅作为诊断证据，修复不依赖角色或材质名称。该规则遵循 [glTF Alpha Coverage](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#alpha-coverage)。

本版实现使用已有 three-mesh-bvh 的间接索引、完整命中列表与 UV 插值，保留源材质，按 Three.js Texture.transformUv、原尺寸缓存像素、过滤方式、alphaTest/opacity 选择第一个真实可见表面。透明洞穿过、同一材质的实心像素仍保留接触。没有复制其他项目的专有碰撞实现。

同时区分普通排斥与明确贴放：坐下和起身保留作者动作，只在稳定坐姿维持有符号接触；无需强制手腕方向、手指归零或向前搜索。上述试验性修正已撤掉。原有连续动画层用于失去支撑后的姿态渐出，避免从坐姿瞬间切站姿。几何查询、动画、实际画面和用户接受分别记录。

第 19 项已由复合坐姿替换为独立的 CC0 OverhandThrow；第 25 项保留窗口坐姿。模型 B 全 25 项与多角度窗口画面、Seed 的重点动作及坐姿、真正内置八千代 profile 的重点动作与窗口关闭过渡已经实际运行。模型衣发效果以对应实际画面为准，不把内置八千代的运行成功当作其长礼服坐姿效果已获用户认可。用户已允许偶发瞬时轻微相交不修，并授权核对完成后直接提交、发布及同步；交付入口统一为 beta.3。

# Third-party notices

YachiyoDesk uses the following open-source runtime components in its application code:

- Electron — MIT License
- Three.js — MIT License
- @pixiv/three-vrm and its bundled VRM modules — MIT License
- @pixiv/three-vrm-animation 3.5.5 — MIT License; official VRMA loading and retargeting
- glTF Validator 2.0.0-dev.3.10 — Apache License 2.0, with bundled Dart notices; isolated import validation
- @moeru/three-mmd and @moeru/three-mmd-physics-ammo 0.2.0-beta.2 — MIT License; original PMX physics runtime
- ammo.js / Bullet Physics — zlib License; rigid-body physics
- ammojs-typed — MIT License; Ammo bindings
- Vite — MIT License (build tooling)
- TypeScript — Apache License 2.0 (build tooling)
- Vitest — MIT License (test tooling)
- electron-builder — MIT License (packaging tooling)

The model is a separate local asset. Its original terms are preserved at `characters/yachiyo/MODEL_LICENSE.txt`. This public build does not publish or redistribute the model.

The PMX integration and runtime lifecycle work draws on [AIRI](https://github.com/moeru-ai/airi), reviewed at commit `b3463466df7a8b32da3a48d11720307cd5459a4b` (MIT License). Relevant implementation references and adaptations are recorded in `docs/AIRI_REVIEW_20261020.md`. Third-party license texts for this integration are included at `electron/THIRD_PARTY_LICENSES.txt` and distributed inside the application archive.

The 2.0 companion and animation work additionally references AIRI commit `c8943f47ca7df375e043461c964ddb2ace3a064e` (MIT). The optional bundled idle animation comes from `packages/stage-ui-three/src/assets/vrm/animations/idle_loop.vrma`; its attribution travels with the asset in `assets/motions/airi-idle.json`. Its hips translation is reanchored to the current character's local rest pose.

The 2026-10-21 seam, constrained skin-gradient, head-surface and missing spring-contact corrections are independently implemented. AIRI reference c8943f47ca7df375e043461c964ddb2ace3a064e was checked for VRM update order, MMD physics prerequisites and interaction hit regions; no additional AIRI implementation or model assets were copied in these corrections. The local verified PMX/model association does not grant redistribution rights to character assets. Desktop Mate was inspected read-only for installation structure and public interaction behavior; no proprietary code, decompiled implementation, animation, or model asset was copied. Current review boundaries are recorded in `docs/REVIEW_20261021.md`.

Glass card, button and input styling adapts [earth34online/blog](https://github.com/earth34online/blog), commit `17576b69801cbd8fe8fd1cf1db04a0df67b82b32`, MIT, Copyright 2026 孤鸿 and Excalibur. Full notices for these additions are included in `electron/THIRD_PARTY_LICENSES.txt`.

## 2026-10-21 桌面接触功能

桌面接触状态机、Win32/DWM 窗口辅助脚本及骨骼接触叠加由本项目独立实现，没有复制 Desktop Mate 程序或资源，也没有新增复制 AIRI 的代码。Windows 系统 API 由本机提供；既有软件、模型及动作各自许可继续适用。

详见 [桌面接触功能与验收](docs/DESKTOP_CONTACTS_20261021.md)。

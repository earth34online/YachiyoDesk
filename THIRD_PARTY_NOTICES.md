# Third-party notices

YachiyoDesk uses the following open-source runtime components in its application code:

- Electron — MIT License
- Three.js — MIT License
- @pixiv/three-vrm and its bundled VRM modules — MIT License
- @moeru/three-mmd and @moeru/three-mmd-physics-ammo 0.2.0-beta.2 — MIT License; original PMX physics runtime
- ammo.js / Bullet Physics — zlib License; rigid-body physics
- ammojs-typed — MIT License; Ammo bindings
- Vite — MIT License (build tooling)
- TypeScript — Apache License 2.0 (build tooling)
- Vitest — MIT License (test tooling)
- electron-builder — MIT License (packaging tooling)

The model is a separate local asset. Its original terms are preserved at `characters/yachiyo/MODEL_LICENSE.txt`. This public build does not publish or redistribute the model.

The PMX integration and runtime lifecycle work draws on [AIRI](https://github.com/moeru-ai/airi), reviewed at commit `b3463466df7a8b32da3a48d11720307cd5459a4b` (MIT License). Relevant implementation references and adaptations are recorded in `docs/AIRI_REVIEW_20261020.md`. Third-party license texts for this integration are included at `electron/THIRD_PARTY_LICENSES.txt` and distributed inside the application archive.

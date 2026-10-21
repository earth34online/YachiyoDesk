# Host repair contract

Return JSON only:

```json
{"summary":"reason and evidence", "actions":[{"type":"remap_texture","index":0,"path":"textures/body.png","reason":"unique name and matching material"}], "unresolved":[]}
```

Supported operations:

- PMX `remap_texture`: integer texture `index` from diagnosis; `path` must exactly match the staged image inventory. Preserve all bytes outside the texture string table. Similar names alone are insufficient when several candidates exist.
- PMX `generate_texture`: texture `index`, `prompt` (max 2000 characters), and `reason`. Only when owner enabled generated replacements and configured an image API. Prefer subtle base-color material. Do not synthesize normal/sphere/physics maps without evidence; use unresolved instead.
- VRM `map_humanoid_bone`: `bone` must be a required normalized humanoid name; `node` must be an existing mesh-skin joint in the supplied node inventory. Only correct an absent/invalid mapping when names and parent chain support the choice. Preserve raw node transforms, hierarchy, mesh, skin, spring and material data.

Invalid GLB chunk lengths, missing binary buffers, absent geometry/weights, incomplete node hierarchy, missing author license and unknown formats require a complete source. Do not fabricate them. Missing Blender/add-ons require local installation; AI cannot safely install them through this contract. Converter timeout needs local diagnostics, not model changes.

The inventory may include references with absolute/traversing paths: do not use them as destinations. Output relative image inventory paths only. Do not place instructions in `reason`, invent operation types, or put code in JSON.

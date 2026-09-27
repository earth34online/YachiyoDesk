"""Conservative, source-bone-aware PMX garment spring conversion.

Only existing independent MMD physics chains are tuned. Never reweight mesh
vertices or spring the humanoid arm/leg bones: doing either detached sleeves in
prior visual reviews and can destroy a source model's good skinning.
"""


def garment_kind(name: str) -> str | None:
    normalized = name.casefold()
    if any(token in normalized for token in ("skirt", "スカート", "裙", "dress", "hem", "裾")):
        return "skirt"
    if any(token in normalized for token in ("sleeve", "袖", "cuff")):
        return "sleeve"
    if any(token in normalized for token in ("cape", "cloak", "マント", "披风", "披風")):
        return "cape"
    if any(token in normalized for token in ("ribbon", "リボン", "bow", "蝴蝶结", "蝴蝶結")):
        return "ribbon"
    return None


def garment_spring_settings(kind: str, joint_index: int, joint_count: int) -> dict[str, float]:
    """Keep roots stable and apply restrained gravity to distal cloth joints."""
    falloff = max(0.0, min(1.0, joint_index / max(1, joint_count - 1)))
    if kind == "skirt":
        return {"stiffness": 0.86 - 0.10 * falloff, "gravity_power": 0.035 + 0.025 * falloff,
                "drag_force": 0.56, "hit_radius": 0.004}
    if kind == "sleeve":
        return {"stiffness": 0.82 - 0.08 * falloff, "gravity_power": 0.025 + 0.020 * falloff,
                "drag_force": 0.60, "hit_radius": 0.003}
    if kind == "cape":
        return {"stiffness": 0.83 - 0.08 * falloff, "gravity_power": 0.035 + 0.020 * falloff,
                "drag_force": 0.58, "hit_radius": 0.004}
    return {"stiffness": 0.90, "gravity_power": 0.018 + 0.012 * falloff,
            "drag_force": 0.58, "hit_radius": 0.002}

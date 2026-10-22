"""Prompts the agent sends to Nemotron, versioned (docs/LANE_A_SPRINT.md §5.5).

Change a prompt → bump its version; the version goes into every trace entry that used it, so a
result can always be traced back to the exact wording.
"""

from __future__ import annotations

VERIFY_VERSION = "verify-v2"  # chosen on val over v1 (docs/LANE_A_ML.md §6.8)

VERIFY_SYSTEM = (
    "You are checking crops from search-and-rescue drone photos taken 40-65 m above ground. "
    "A person is usually 40-80 px tall, seen from above, often partly hidden. "
    "Answer only from what is visible. Return JSON matching the schema. "
    "If you cannot tell, use `unclear`. Never guess clothing you can't see. "
    'Never use the words "clear", "clears", "cleared" or "clearing".'
)

VERIFY_USER = (
    "Is there a person at the centre of this crop? The images show the same spot:\n"
    "{images}\n"
    "Reply with only a JSON object: person (yes/no/unclear), posture "
    "(standing/sitting/lying/unknown), group_size (number of people, or null), clothing "
    "(visible colours and garments, or null), reason (one sentence on what you see)."
)

# v2: stricter about what counts as a person, after v1 called 60 % of near-miss false positives
# "yes" on val (docs/LANE_A_ML.md §6.8). Unsure goes to `unclear`, not `no`, so people the
# model can't make out are not argued away.
VERIFY_SYSTEM_V2 = (
    VERIFY_SYSTEM + " Answer `yes` only if you can see a human shape: a head with a body, limbs, "
    "or a person's outline and shadow. A patch of colour alone is not enough. Rocks, logs, "
    "stumps, shadows, bushes, bags, tents and clothing lying on the ground are common false "
    "alarms in these photos. If the shape could be a person but you cannot see enough to say, "
    "answer `unclear`."
)

# version -> (system prompt, user prompt); the user prompt is shared.
VERIFY_PROMPTS = {
    "verify-v1": (VERIFY_SYSTEM, VERIFY_USER),
    "verify-v2": (VERIFY_SYSTEM_V2, VERIFY_USER),
}

VERIFY_RETRY = "That reply was not a valid JSON object for the schema. Reply with only the JSON."

# How each image is described to the model, by source.
IMAGE_LABELS = {
    "crop": "the detector's crop",
    "enhance_contrast": "the same spot with contrast enhanced (CLAHE)",
    "zoom_native": "a zoom from the original photo's full-resolution pixels",
    "redetect_region": (
        "the detector run again at native resolution and 2x upscaled; its boxes are drawn in yellow"
    ),
}

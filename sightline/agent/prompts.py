"""Prompts the agent sends to Nemotron, versioned (docs/LANE_A_SPRINT.md §5.5).

Change a prompt → bump its version; the version goes into every trace entry that used it, so a
result can always be traced back to the exact wording.
"""

from __future__ import annotations

VERIFY_VERSION = "verify-v1"

VERIFY_SYSTEM = (
    "You are checking crops from search-and-rescue drone photos taken 40-65 m above ground. "
    "A person is usually 40-80 px tall, seen from above, often partly hidden. "
    "Answer only from what is visible. Return JSON matching the schema. "
    "If you cannot tell, use `unclear`. Never guess clothing you can't see. "
    'Never use the words "clear" or "cleared".'
)

VERIFY_USER = (
    "Is there a person at the centre of this crop? The images show the same spot:\n"
    "{images}\n"
    "Reply with only a JSON object: person (yes/no/unclear), posture "
    "(standing/sitting/lying/unknown), group_size (number of people, or null), clothing "
    "(visible colours and garments, or null), reason (one sentence on what you see)."
)

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

"""Prompts the agent sends to Nemotron, versioned (docs/LANE_A_SPRINT.md §5.5).

Change a prompt → bump its version; the version goes into every trace entry that used it, so a
result can always be traced back to the exact wording.
"""

from __future__ import annotations

VERIFY_VERSION = "verify-v3"  # v2 (chosen on val over v1, docs/LANE_A_ML.md §6.8) + object

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

# v3 (contract 15.7): v2's person rules word for word, plus one field: when there is no person, the
# thing a lost person may have left or used (a backpack, a fire ring, a shelter) is named, so the
# reviewer can make it a clue candidate. The person answer is v2's; only `object` is new.
VERIFY_SYSTEM_V3 = (
    VERIFY_SYSTEM_V2 + " Also say what object is at the centre when it is not a person: "
    "`backpack` (a backpack or bag), `fire ring` (a ring of stones or the remains of a campfire), "
    "`shelter` (a tent, tarp or lean-to), `other` (another thing a person carried or left), or "
    "null (nothing made by people: rock, wood, plants, ground, shadow)."
)
VERIFY_USER_V3 = VERIFY_USER.replace(
    "(visible colours and garments, or null), ",
    "(visible colours and garments, or null), object (backpack/fire ring/shelter/other, or null), ",
)

# version -> (system prompt, user prompt)
VERIFY_PROMPTS = {
    "verify-v1": (VERIFY_SYSTEM, VERIFY_USER),
    "verify-v2": (VERIFY_SYSTEM_V2, VERIFY_USER),
    "verify-v3": (VERIFY_SYSTEM_V3, VERIFY_USER_V3),
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

# --- radio briefings (loop.write_briefing, MODEL_FAST) -------------------------------------------
# v2, after the live creek run (docs/report/AGENT_EVAL.md): with v1 ("at most 60 words", rules as
# prose) Nemotron 3 Nano copied the planner's 48-word reason word for word, and 8 of 19 briefings
# fell back to the template. v2 gives the limits as a numbered list with a smaller word budget than
# the 60-word check, one good and one bad example, and a retry that quotes the reason and the count.
BRIEFING_VERSION = "briefing-v2"
BRIEFING_TARGET_WORDS = 45  # asked of the model; check_briefing rejects only above 60

# The example's numbers differ from any mission's, so a copied number is caught as invented. Its
# "why" is a planner reason in the evidence format (at most planner.REASON_WORDS words: what moved
# the sector since the last plan, then why a ground team; docs/architecture/agent.md).
_BRIEFING_EXAMPLE_FACTS = (
    '{"team": "Team Five", "sector": "D4", "why": "D4 · 6.2 % of remaining probability, up from '
    "4.0 %: c007 (red cap on the ridge…) raised it; 70% under tree cover (drone POD 0.38): a "
    'ground team adds the most here; Team Five is nearest (410 m, about 9 min on foot).", '
    '"subject": "child, green coat", "daylight_left": "2 h 10 min", "weather": "wind 12 km/h"}'
)
_BRIEFING_GOOD = (
    "Team Five, search sector D4. Clue c007, a red cap on the ridge, raised it to 6.2% of the "
    "probability. 70% under trees, hard for drones. About 9 min on foot. Subject: child, "
    "green coat. 2 h 10 min of daylight, wind 12 km/h. Over."
)
_BRIEFING_BAD = (
    "Team Five, D4 · 6.2 % of remaining probability, up from 4.0 %: c007 (red cap on the ridge…) "
    "raised it; 70% under tree cover (drone POD 0.38): a ground team adds the most here; Team Five "
    "is nearest (410 m, about 9 min on foot). Subject is child, green coat. Daylight left is "
    "2 h 10 min. Weather is wind 12 km/h."
)
# An alert to every team: live, v2 without this example still wrote "All teams, search sector C3".
_BRIEFING_ALERT_FACTS = (
    '{"what": "a reviewer confirmed a person in a drone photo", "photo": "f0042", "sector": "D4", '
    '"subject": "child, green coat", "posture": "sitting"}'
)
_BRIEFING_ALERT = (
    "All teams, a reviewer confirmed a person in drone photo f0042, sector D4. Child, green coat, "
    "sitting. Over."
)

BRIEFING_SYSTEM = (
    "You write radio briefings for search-and-rescue ground teams. The operator reads them aloud.\n"
    "Hard limits:\n"
    f"1. At most {BRIEFING_TARGET_WORDS} words. Two to four short sentences.\n"
    "2. Plain punctuation: every sentence ends with a full stop; commas between items.\n"
    "3. Use only the facts given. Every number must be in the facts, written in digits as in the "
    "facts. Leave out numbers the team does not need. No coordinates.\n"
    "4. Never copy a long fact word for word. From a long reason keep only the main point in a "
    "few words.\n"
    "5. Never tell a team to stop, stand down or wait, and never say that no action is needed. "
    "Say what to do instead, and only a task the facts give (a team and a sector to search: "
    '"search sector D4"). With no task in the facts, report the facts and give no order.\n'
    "6. A person seen in a photo is a sighting, not a find. Add no urgency beyond the facts.\n"
    '7. Never say "clear", "clears", "cleared" or "clearing".\n'
    '8. Start with the team\'s name if the facts give one, otherwise "All teams". '
    'End with "Over."\n\n'
    f"Example facts: {_BRIEFING_EXAMPLE_FACTS}\n"
    f"Good briefing ({len(_BRIEFING_GOOD.split())} words): {_BRIEFING_GOOD}\n"
    f"Bad briefing ({len(_BRIEFING_BAD.split())} words, copies the reason word for word, "
    f"no Over): {_BRIEFING_BAD}\n\n"
    f"Example facts with no team and no task: {_BRIEFING_ALERT_FACTS}\n"
    f"Good briefing (no order: the facts give none): {_BRIEFING_ALERT}"
)


def briefing_user(facts_json: str) -> str:
    return (
        f"Facts:\n{facts_json}\n\nWrite the briefing: at most {BRIEFING_TARGET_WORDS} words, "
        'ending with "Over."'
    )


def briefing_retry(problems: list[str], words: int, facts_json: str) -> str:
    """The retry turn: quotes why the last briefing was rejected and how long it was."""
    return (
        f"That briefing was rejected. It had {words} words. Reasons: {'; '.join(problems)}.\n"
        f"Write it again from these facts only, at most {BRIEFING_TARGET_WORDS} words, in short "
        'sentences with full stops, ending with "Over." Do not copy any fact word for word.\n'
        f"Facts:\n{facts_json}"
    )

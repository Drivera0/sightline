"""Sightline architecture diagrams, drawn with the Diagram Design skill's rules.

Four figures on one page, as the skill's "overview + detail" split recommends:
1. the system (architecture type): survey photos to the searcher, with lanes A, B, C, D;
2. the ML pipeline: training and evaluation offline, then tiled inference on every survey;
3. a live mission on AWS (``live.png``): per photo through S3/SQS to the cv2.dnn worker and the store;
4. the agent (``agent.png``): perception → OpenCV 5 re-look → decision → proposal → approval → effect.

Style, connector rules and accessible-SVG contract follow
https://github.com/cathrynlavery/diagram-design (MIT); the colours and fonts are Sightline's
(web/src/shell/theme.css). Every number is from metrics.json, the weights-v2 release or
scripts/README.md. Check the output with the skill's scripts:

    python docs/architecture/build_architecture.py
    python <diagram-design>/scripts/verify-geometry.py docs/architecture/sightline-architecture.html
    python <diagram-design>/skills/diagram-design/scripts/self_check.py docs/architecture/sightline-architecture.html
"""

from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).resolve().parent / "sightline-architecture.html"

# ---------------------------------------------------------------- skin (Sightline)
PAPER, PAPER2 = "#0a0b0d", "#16171b"
INK, MUTED, SOFT, ACCENT, LINK = "#f2f2f0", "#a1a1aa", "#8a8a93", "#ff7a1a", "#8fb4ff"
SANS, MONO = "'Geist', sans-serif", "'Geist Mono', monospace"


def ink(a: float) -> str:
    return f"rgba(242,242,240,{a})"


def acc(a: float) -> str:
    return f"rgba(255,122,26,{a})"


# Node treatments: (fill, stroke, tag stroke, tag text)
KIND = {
    "focal": (acc(0.10), ACCENT, acc(0.55), ACCENT),
    "step": (PAPER2, ink(0.55), ink(0.30), INK),
    "store": (ink(0.05), MUTED, ink(0.30), MUTED),
    "external": (ink(0.02), ink(0.30), ink(0.25), SOFT),
}

W, H = 160, 72
COLS = [48, 264, 480, 696, 912]  # 160 wide, 56 apart, in a 1120 canvas
CANVAS_W = 1120


def text_w(s: str, size: float, mono: bool = True) -> float:
    return len(s) * size * (0.62 if mono else 0.60)


def grid(v: float) -> int:
    return int(-(-v // 4) * 4)


class Fig:
    def __init__(self, slug: str):
        self.slug = slug
        self.zones: list[str] = []
        self.arrows: list[str] = []
        self.labels: list[str] = []
        self.nodes: list[str] = []
        self.legend: list[str] = []

    # -------------------------------------------------------------- primitives
    def zone(self, x, y, w, h, label):
        lw = grid(text_w(label, 7) + 16)
        self.zones.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{ink(0.02)}" stroke="{ink(0.10)}" stroke-width="0.8"/>'
            f'<rect x="{x + 16}" y="{y + 4}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>'
            f'<text x="{x + 16 + lw / 2}" y="{y + 13}" fill="{SOFT}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.14em">{label}</text>'
        )

    def node(self, x, y, kind, tag, name, sub1, sub2=""):
        fill, stroke, tag_stroke, tag_text = KIND[kind]
        tw = grid(text_w(tag, 7) + 10)
        cx = x + W / 2
        parts = [
            f'<rect x="{x}" y="{y}" width="{W}" height="{H}" rx="6" fill="{PAPER}"/>',
            f'<rect x="{x}" y="{y}" width="{W}" height="{H}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1"/>',
            f'<rect x="{x + 8}" y="{y + 6}" width="{tw}" height="12" rx="2" fill="transparent" stroke="{tag_stroke}" stroke-width="0.8"/>',
            f'<text x="{x + 8 + tw / 2}" y="{y + 15}" fill="{tag_text}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.08em">{tag}</text>',
            f'<text x="{cx}" y="{y + 37}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{name}</text>',
            f'<text x="{cx}" y="{y + 52}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{sub1}</text>',
        ]
        if sub2:
            parts.append(
                f'<text x="{cx}" y="{y + 64}" fill="{ACCENT if kind == "focal" else SOFT}" font-size="9" font-family="{MONO}" text-anchor="middle">{sub2}</text>'
            )
        self.nodes.append("".join(parts))

    def path(self, d, style="muted", dashed=False):
        color, marker, sw = {
            "muted": (MUTED, "arrow", 1.2),
            "accent": (ACCENT, "arrow-accent", 1.4),
            "link": (LINK, "arrow-link", 1.2),
        }[style]
        dash = ' stroke-dasharray="4,3"' if dashed else ""
        if dashed:
            sw = 1
        self.arrows.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{dash} marker-end="url(#{self.slug}-{marker})"/>'
        )

    def label(
        self,
        text,
        cx=None,
        y_line=None,
        side=None,
        x_line=None,
        y_mid=None,
        below=False,
        color=SOFT,
    ):
        w = grid(text_w(text, 8) + 10)
        if side is None:  # horizontal segment: centred above (or below) with an 8px gap
            y = y_line + 8 if below else y_line - 20
            x = cx - w / 2
            tx, anchor = cx, "middle"
        else:  # vertical segment: beside it with an 8px gap
            y = y_mid - 6
            if side == "right":
                x = x_line + 8
            else:
                x = x_line - 8 - w
            tx, anchor = x + w / 2, "middle"
        self.labels.append(
            f'<rect x="{f(x)}" y="{f(y)}" width="{w}" height="12" rx="2" fill="{PAPER}"/>'
            f'<text x="{f(tx)}" y="{f(y + 9)}" fill="{color}" font-size="8" font-family="{MONO}" text-anchor="{anchor}" letter-spacing="0.06em">{text}</text>'
        )

    def legend_strip(self, y, items):
        self.legend.append(
            f'<line x1="48" y1="{y - 8}" x2="{CANVAS_W - 48}" y2="{y - 8}" stroke="{ink(0.10)}" stroke-width="0.8"/>'
            f'<text x="48" y="{y + 8}" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.18em">LEGEND</text>'
        )
        x = 120
        for kind, text in items:
            if kind in KIND:
                fill, stroke, _, _ = KIND[kind]
                self.legend.append(
                    f'<rect x="{x}" y="{y}" width="14" height="10" rx="2" fill="{fill}" stroke="{stroke}" stroke-width="1"/>'
                )
            else:
                color, marker, dash = {
                    "accent": (ACCENT, "arrow-accent", ""),
                    "muted": (MUTED, "arrow", ""),
                    "dashed": (MUTED, "arrow", ' stroke-dasharray="4,3"'),
                    "link": (LINK, "arrow-link", ""),
                }[kind]
                self.legend.append(
                    f'<line x1="{x}" y1="{y + 5}" x2="{x + 24}" y2="{y + 5}" stroke="{color}" stroke-width="1.2"{dash} marker-end="url(#{self.slug}-{marker})"/>'
                )
            off = 30 if kind not in KIND else 20
            self.legend.append(
                f'<text x="{x + off}" y="{y + 9}" fill="{MUTED}" font-size="8.5" font-family="{SANS}">{text}</text>'
            )
            x += off + grid(text_w(text, 8.5, mono=False)) + 28

    def svg(self, height, title, desc):
        s = self.slug
        markers = "".join(
            f'<marker id="{s}-{mid}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="{c}"/></marker>'
            for mid, c in (("arrow", MUTED), ("arrow-accent", ACCENT), ("arrow-link", LINK))
        )
        body = "\n        ".join(
            [
                f'<rect width="100%" height="100%" fill="{PAPER}"/>',
                *self.zones,
                *self.arrows,
                *self.labels,
                *self.nodes,
                *self.legend,
            ]
        )
        # The first zone starts at y=80; start the view at y=48 so the figure sits under its heading.
        return (
            f'<svg viewBox="0 48 {CANVAS_W} {height - 48}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="{s}-title {s}-desc">\n'
            f'        <title id="{s}-title">{title}</title>\n        <desc id="{s}-desc">{desc}</desc>\n'
            f"        <defs>{markers}</defs>\n        {body}\n      </svg>"
        )


def f(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


R = 8  # elbow radius


def elbow_up_right(x0, y0, y_turn, x1, y1):
    """Leave a top edge going up, turn right at y_turn, turn up again into a bottom edge at x1."""
    return (
        f"M {x0},{y0} V {y_turn + R} Q {x0},{y_turn} {x0 + R},{y_turn} "
        f"H {x1 - R} Q {x1},{y_turn} {x1},{y_turn - R} V {y1}"
    )


# ---------------------------------------------------------------- figure 1: the system


def system() -> str:
    g = Fig("system")
    top, mid, bot = 112, 296, 448
    g.zone(248, 80, 624, 128, "LANES A · B · C · CALLED BY THE PIPELINE")
    c0, c1, c2, c3, c4 = COLS
    # arrows (drawn before nodes)
    g.path(f"M {c0 + W},{mid + 36} H {c1}")  # survey -> pipeline
    g.label("PHOTOS", cx=(c0 + W + c1) / 2, y_line=mid + 36)
    g.path(f"M {c1 + 40},{mid} V {top + H}", "accent")  # pipeline -> detector
    g.label("DETECT", side="left", x_line=c1 + 40, y_mid=mid - 28, color=ACCENT)
    g.path(elbow_up_right(c1 + 80, mid, 240, c2 + 80, top + H))  # pipeline -> geo
    g.label("GEOREF", cx=(c1 + 88 + c2 + 72) / 2, y_line=240)
    g.path(elbow_up_right(c1 + 120, mid, 256, c3 + 80, top + H))  # pipeline -> search map
    g.label("MAP", cx=(c2 + W + c3) / 2 + 20, y_line=256, below=True)
    g.path(f"M {c1 + W},{mid + 36} H {c2}")  # pipeline -> cache
    g.label("WRITES", cx=(c1 + W + c2) / 2, y_line=mid + 36)
    g.path(f"M {c2 + 80},{mid + H} V {bot}")  # cache -> releases
    g.label("PUBLISH", side="right", x_line=c2 + 80, y_mid=(mid + H + bot) / 2)
    g.path(
        f"M {c2 + W},{bot + 36} H {c3 + 80 - R} Q {c3 + 80},{bot + 36} {c3 + 80},{bot + 36 - R} V {mid + H}",
        "link",
    )
    g.label("BUILD", side="right", x_line=c3 + 80, y_mid=(mid + H + bot + 36) / 2, color=LINK)
    g.path(f"M {c3 + W},{mid + 24} H {c4}")  # website -> searcher
    g.label("QUEUE", cx=(c3 + W + c4) / 2, y_line=mid + 24)
    g.path(f"M {c4},{mid + 48} H {c3 + W}", dashed=True)  # searcher answers
    g.label("ANSWERS", cx=(c3 + W + c4) / 2, y_line=mid + 48, below=True)
    # nodes
    g.node(c1, top, "focal", "LANE A", "Detector", "YOLO11s · tiled", "recall 0.864")
    g.node(c2, top, "step", "LANE B", "Geo", "EXIF pose → footprints", "pins ± 10 m")
    g.node(c3, top, "step", "LANE C", "Search map", "Bayesian grid", "updates every photo")
    g.node(c0, mid, "external", "INPUT", "Drone survey", "500 photos (demo)", "or real EXIF photos")
    g.node(c1, mid, "step", "LANE D", "Pipeline", "8 stages · Typer CLI", "frames → export")
    g.node(c2, mid, "store", "CACHE", "Cache", "contract 1.1 · 5 JSON", "validated on export")
    g.node(c3, mid, "step", "SITE", "Website", "React · MapLibre", "reads the cache only")
    g.node(c4, mid, "external", "HUMAN", "Searcher", "reviews the queue", "P · N · U keys")
    g.node(
        c2,
        bot,
        "store",
        "RELEASES",
        "GitHub releases",
        "demo · real-gps · weights",
        "pulled by the Vercel build",
    )
    g.legend_strip(
        568,
        [
            ("focal", "Focal: the model"),
            ("step", "Component"),
            ("store", "Data"),
            ("external", "Outside the system"),
            ("accent", "Detection call"),
            ("link", "HTTPS download"),
            ("dashed", "Searcher answers"),
        ],
    )
    return g.svg(
        600,
        "Sightline system architecture",
        "Architecture of Sightline: survey photos go through lane D's pipeline, which calls the detector, georeferencing and the search map, writes a validated cache that is published as a GitHub release and built into the website a searcher reviews.",
    )


# ---------------------------------------------------------------- figure 2: the ML pipeline


def ml() -> str:
    g = Fig("ml")
    top, bot = 112, 312
    c0, c1, c2, c3, c4 = COLS
    g.zone(32, 80, 1056, 128, "OFFLINE · TRAIN AND EVALUATE ONCE (GPU)")
    g.zone(32, 280, 1056, 128, "EVERY SURVEY · INSIDE THE PIPELINE")
    y = top + 36
    for a, b, text in ((c0, c1, "TILE"), (c1, c2, "TRAIN"), (c2, c3, "VAL"), (c3, c4, "TEST")):
        g.path(f"M {a + W},{y} H {b}")
        g.label(text, cx=(a + W + b) / 2, y_line=y)
    yb = bot + 36
    g.path(f"M {c0 + W},{yb} H {c2}")
    g.label("SCORE EVERY", cx=(c0 + W + c2) / 2, y_line=yb)
    for a, b, text in ((c2, c3, "FILTER"), (c3, c4, "RANK")):
        g.path(f"M {a + W},{yb} H {b}")
        g.label(text, cx=(a + W + b) / 2, y_line=yb)
    g.path(f"M {c2 + 80},{top + H} V {bot}", "accent")  # weights-v2 into inference
    g.label("WEIGHTS-V2", side="right", x_line=c2 + 80, y_mid=(top + H + bot) / 2, color=ACCENT)
    g.path(f"M {c3 + 80},{top + H} V {bot}", dashed=True)  # threshold reused
    g.label("0.29", side="right", x_line=c3 + 80, y_mid=(top + H + bot) / 2)
    # nodes
    g.node(
        c0, top, "store", "DATA", "HERIDAL photos", "1,391 train · 155 val", "101 test · 4000×3000"
    )
    g.node(c1, top, "step", "PREP", "Tiler", "1024 px · 20% overlap", "890 labelled photos")
    g.node(
        c2, top, "focal", "MODEL", "YOLO11s fine-tune", "80 epochs · from COCO", "9.43 M parameters"
    )
    g.node(c3, top, "step", "TUNE", "Threshold", "max F2 on validation", "candidate ≥ 0.29")
    g.node(
        c4, top, "step", "TEST", "Test evaluation", "101 photos · 337 people", "P 0.802 · R 0.864"
    )
    g.node(
        c0, bot, "external", "INPUT", "Survey photos", "500 frames (demo)", "or 10 real EXIF photos"
    )
    g.node(
        c2,
        bot,
        "step",
        "INFER",
        "Tiled inference",
        "SAHI · 1024 px slices",
        "NMS 0.5 · 0.25 s/photo",
    )
    g.node(c3, bot, "step", "KEEP", "Candidates", "boxes ≥ 0.29", "crops + map pins")
    g.node(c4, bot, "store", "OUTPUT", "Ranked queue", "most confident first", "6 of 6 by photo 7")
    g.legend_strip(
        448,
        [
            ("focal", "Focal: the model"),
            ("step", "Step"),
            ("store", "Data"),
            ("external", "Input"),
            ("accent", "Trained weights"),
            ("muted", "Data flow"),
            ("dashed", "Threshold reused"),
        ],
    )
    return g.svg(
        480,
        "Sightline ML pipeline",
        "The detector's pipeline: HERIDAL photos are tiled to train YOLO11s, a threshold is chosen on validation and the model is tested once, then every survey is scored with tiled inference, filtered at the threshold and ranked for review.",
    )


# ---------------------------------------------------------------- figure 3: the agent (A-G2)


def agent() -> str:
    g = Fig("agent")
    top, bot = 112, 312
    c0, c1, c2, c3, c4 = COLS
    g.zone(32, 80, c2 + W + 16 - 32, 128, "SECOND LOOK · OPENCV 5 + NEMOTRON VL")
    g.zone(32, 280, c1 + W + 16 - 32, 128, "PLANNING · LANES B AND C")
    y = top + 36
    g.path(f"M {c0 + W},{y} H {c1}", "accent")
    g.label("NEAR-MISS", cx=(c0 + W + c1) / 2, y_line=y, color=ACCENT)
    g.path(f"M {c1 + W},{y} H {c2}", "accent")
    g.label("IMAGES", cx=(c1 + W + c2) / 2, y_line=y, color=ACCENT)
    g.path(f"M {c2 + W},{y} H {c3}")
    g.label("VERDICT", cx=(c2 + W + c3) / 2, y_line=y)
    g.path(f"M {c3 + W},{y} H {c4}")
    g.label("PROPOSAL", cx=(c3 + W + c4) / 2, y_line=y)
    yb = bot + 36
    g.path(f"M {c0 + W},{yb} H {c1}")
    g.label("EVENTS", cx=(c0 + W + c1) / 2, y_line=yb)
    g.path(elbow_up_right(c1 + 120, bot, 248, c3 + 40, top + H))  # planner -> proposal
    g.label("LEGS · TEAMS", cx=(c2 + c2 + W) / 2, y_line=248)
    g.path(f"M {c3 + 120},{top + H} V {bot}", dashed=True)  # proposal -> trace
    g.label("LOGGED", side="right", x_line=c3 + 120, y_mid=(top + H + bot) / 2)
    g.path(f"M {c4 + 80},{top + H} V {bot}", "accent")  # approval -> effect
    g.label("APPROVED", side="right", x_line=c4 + 80, y_mid=(top + H + bot) / 2, color=ACCENT)
    yl = bot + H + 40  # effects come back as new evidence: the loop closes
    g.path(
        f"M {c4 + 80},{bot + H} V {yl - R} Q {c4 + 80},{yl} {c4 + 80 - R},{yl} "
        f"H {c0 + 80 + R} Q {c0 + 80},{yl} {c0 + 80},{yl - R} V {bot + H}",
        dashed=True,
    )
    g.label("NEW PHOTOS · REPORTS", cx=(c1 + c3 + W) / 2, y_line=yl, below=True)
    g.node(c0, top, "step", "PERCEPTION", "Detector", "cv2.dnn · YOLO11s", "conf 0.15 to 0.29")
    g.node(c1, top, "focal", "OPENCV 5", "Re-look tools", "CLAHE · native zoom", "re-detect 2×")
    g.node(c2, top, "step", "DECISION", "Nemotron VL", "person · posture · group", "JSON · 1.4 s")
    g.node(c3, top, "step", "ACTION", "Proposal", "promote · leg · assign", "reason + evidence")
    g.node(
        c4, top, "external", "HUMAN", "Search manager", "approve · edit · reject", "who and when"
    )
    g.node(
        c0, bot, "external", "EVIDENCE", "Field and map", "clues · reviews", "conditions (Tavily)"
    )
    g.node(c1, bot, "step", "PLAN", "Info-gain planner", "propose_legs", "propose_assignments")
    g.node(c3, bot, "store", "TRACE", "trace.jsonl", "every tool + model call", "images by path")
    g.node(
        c4,
        bot,
        "step",
        "EFFECT",
        "Queue · drones · radio",
        "only after approval",
        "never automatic",
    )
    g.legend_strip(
        464,
        [
            ("focal", "Focal: OpenCV 5"),
            ("step", "Agent step"),
            ("store", "Log"),
            ("external", "People and the field"),
            ("accent", "Vision path"),
            ("muted", "Agent flow"),
            ("dashed", "Logged / loops back"),
        ],
    )
    return g.svg(
        496,
        "Sightline agent workflow",
        "The agent: a near-miss detection gets OpenCV 5 re-look images, Nemotron VL gives a verdict, "
        "the agent turns it and the planner's legs into a proposal, the search manager approves it, "
        "and only then does anything happen; every step is logged and new evidence starts the loop again.",
    )


# ---------------------------------------------------------------- figure 4: a live mission on AWS


def live() -> str:
    g = Fig("live")
    top, mid, bot = 112, 296, 448
    c0, c1, c2, c3, c4 = COLS
    g.zone(248, 80, c4 + W + 16 - 248, 128, "AWS · ONE EC2 INSTANCE + MANAGED SERVICES")
    # the per-photo path, left to right
    g.path(f"M {c0 + W},{top + 36} H {c1}")
    g.label("PHOTOS", cx=(c0 + W + c1) / 2, y_line=top + 36)
    g.path(f"M {c1 + W},{top + 36} H {c2}")
    g.label("JOB", cx=(c1 + W + c2) / 2, y_line=top + 36)
    g.path(f"M {c2 + W},{top + 36} H {c3}", "accent")
    g.label("NEXT PHOTO", cx=(c2 + W + c3) / 2, y_line=top + 36, color=ACCENT)
    g.path(f"M {c3 + W},{top + 36} H {c4}", dashed=True)
    g.label("METRICS", cx=(c3 + W + c4) / 2, y_line=top + 36)
    # the worker writes the mission (above the middle row, then down into the store)
    g.path(f"M {c3 + 40},{top + H} V {256 - R} Q {c3 + 40},256 {c3 + 40 - R},256 H {c1 + 80 + R} Q {c1 + 80},256 {c1 + 80},{256 + R} V {mid}", "accent")
    g.label("FRAME · DETECTIONS · MAP STEP", cx=(c2 + c2 + W) / 2, y_line=256, color=ACCENT)
    g.path(f"M {c1 + 40},{top + H} V {mid}")  # the API's own writes
    g.label("DECISIONS", side="left", x_line=c1 + 40, y_mid=(top + H + mid) / 2)
    # people and the agent around the store
    g.path(f"M {c0 + W},{mid + 24} H {c1}")
    g.label("APPROVE", cx=(c0 + W + c1) / 2, y_line=mid + 24)
    g.path(f"M {c1},{mid + 48} H {c0 + W}", dashed=True)
    g.label("SSE", cx=(c0 + W + c1) / 2, y_line=mid + 48, below=True)
    g.path(f"M {c1 + W},{mid + 24} H {c2}")
    g.label("HOOKS", cx=(c1 + W + c2) / 2, y_line=mid + 24)
    g.path(f"M {c2},{mid + 48} H {c1 + W}", dashed=True)
    g.label("PROPOSALS", cx=(c1 + W + c2) / 2, y_line=mid + 48, below=True)
    g.path(f"M {c2 + W},{mid + 36} H {c3}")
    g.label("NEMOTRON", cx=(c2 + W + c3) / 2, y_line=mid + 36)
    # conditions from the web
    g.path(f"M {c1 + 80},{bot} V {mid + H}")
    g.label("CONDITIONS", side="right", x_line=c1 + 80, y_mid=(mid + H + bot) / 2)
    g.path(f"M {c1 + W},{bot + 36} H {c2}")
    g.label("SEARCH", cx=(c1 + W + c2) / 2, y_line=bot + 36)
    # nodes
    g.node(c0, top, "external", "INPUT", "Photos in", "SD card · watch folder", "fleet sim (simulated)")
    g.node(c1, top, "step", "API", "Mission API", "FastAPI · Caddy HTTPS", "SSE with resume")
    g.node(c2, top, "store", "S3 · SQS", "Originals · jobs", "S3 30 days · SQS FIFO", "one group per mission")
    g.node(c3, top, "focal", "WORKER", "Per-photo pipeline", "pose → cv2.dnn tiled", "≈ 7 s / photo · 8 vCPU")
    g.node(c4, top, "store", "CLOUDWATCH", "Logs · metrics", "latency · queue · agent", "one dashboard")
    g.node(c0, mid, "external", "HUMAN", "Search manager", "console · radio", "approves every move")
    g.node(c1, mid, "store", "STORE", "MissionStore", "the only writer", "validate_mission()")
    g.node(c2, mid, "step", "AGENT", "Second look · planner", "verdicts · proposals", "briefings")
    g.node(c3, mid, "external", "NEBIUS", "Token Factory", "Nemotron VL · Super", "Nano · key in Secrets Mgr")
    g.node(c1, bot, "step", "LANE B", "Conditions", "every 30 min · cached", "values only with a quote")
    g.node(c2, bot, "external", "WEB", "Tavily", "3 searches + 1 extract", "forecast · alerts")
    g.legend_strip(
        568,
        [
            ("focal", "Focal: OpenCV 5 cv2.dnn"),
            ("step", "Component"),
            ("store", "Data"),
            ("external", "Outside the system"),
            ("accent", "Photo path"),
            ("muted", "Calls"),
            ("dashed", "Events back"),
        ],
    )
    return g.svg(
        600,
        "Sightline live mission on AWS",
        "A live mission on AWS: photos reach the mission API, which keeps the original in S3 and queues a job in SQS; "
        "a worker runs the pose, OpenCV 5 cv2.dnn and the map step and writes the mission store; the search manager "
        "approves moves and sees events over SSE; the agent reads the store and calls Nemotron on Token Factory; "
        "conditions come from Tavily; metrics and logs go to CloudWatch.",
    )


# ---------------------------------------------------------------- page

FONT = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap"

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sightline architecture</title>
  <link href="{font}" rel="stylesheet">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    :root {{ --paper:{paper}; --paper-2:{paper2}; --ink:{ink}; --muted:{muted}; --soft:{soft}; --rule:rgba(242,242,240,0.12); --accent:{accent};
             --font-sans:'Geist',system-ui,sans-serif; --font-serif:'Instrument Serif',serif; --font-mono:'Geist Mono',ui-monospace,monospace; }}
    body {{ font-family: var(--font-sans); background: var(--paper); color: var(--ink); min-height: 100vh; padding: 3rem 2rem; }}
    .container {{ max-width: 1240px; margin: 0 auto; }}
    .eyebrow {{ font-family: var(--font-mono); font-size: 0.66rem; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 0.75rem; }}
    h1 {{ font-family: var(--font-serif); font-size: clamp(1.75rem, 3vw + 1rem, 2.6rem); font-weight: 400; letter-spacing: -0.02em; line-height: 1.1; margin-bottom: 0.6rem; }}
    h2 {{ font-family: var(--font-serif); font-size: 1.6rem; font-weight: 400; letter-spacing: -0.01em; margin: 2.75rem 0 0.4rem; }}
    .subtitle {{ font-size: 1rem; line-height: 1.55; color: var(--muted); max-width: 66ch; }}
    .diagram-container {{ overflow-x: auto; margin-top: 1rem; }}
    svg {{ width: 100%; min-width: 1120px; display: block; }}
    @media print {{ .diagram-container {{ overflow-x: visible; }} svg {{ min-width: 0; }} }}
    .cards {{ display: grid; grid-template-columns: 1.1fr 1fr 0.9fr; gap: 1rem; margin-top: 2.5rem; }}
    @media (max-width: 820px) {{ .cards {{ grid-template-columns: 1fr; }} }}
    .card {{ background: var(--paper-2); border-radius: 6px; border: 1px solid var(--rule); padding: 1.25rem; }}
    .card-header {{ display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.875rem; padding-bottom: 0.875rem; border-bottom: 1px solid var(--rule); }}
    .card-dot {{ width: 7px; height: 7px; border-radius: 50%; }}
    .card-dot.ink {{ background: var(--ink); }} .card-dot.muted {{ background: var(--muted); }} .card-dot.coral {{ background: var(--accent); }}
    .card h3 {{ font-size: 0.875rem; font-weight: 600; }}
    .card p, .card ul {{ color: var(--muted); font-size: 0.8125rem; line-height: 1.55; list-style: none; }}
    .card li {{ margin-bottom: 0.3rem; padding-left: 0.875rem; position: relative; }}
    .card li::before {{ content: '·'; position: absolute; left: 0.2rem; color: var(--soft); }}
    .footer {{ margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.06em; color: var(--soft); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }}
  </style>
</head>
<body>
  <div class="container">
    <p class="eyebrow">Architecture · Sightline</p>
    <h1>From drone photos to where to search next</h1>
    <p class="subtitle">A detector reads every drone photo and ranks them for a human searcher; each confirmed person becomes a pin on the map, and a Bayesian probability map shows where the person could still be. Four lanes, one contract between them.</p>

    <h2>The system</h2>
    <p class="subtitle">Lane D's pipeline calls the other three lanes, writes one validated cache, and the website only ever reads it.</p>
    <div class="diagram-container">
      {system}
    </div>

    <h2>The ML pipeline</h2>
    <p class="subtitle">Trained and tested once on HERIDAL, then the same weights and the same 0.29 threshold score every survey.</p>
    <div class="diagram-container">
      {ml}
    </div>

    <h2>A live mission</h2>
    <p class="subtitle">Sprint 2: the same detector and map per photo, while the search happens. On AWS (deploy/aws/) the API and the worker are containers on one EC2 instance; locally the queue is a thread.</p>
    <div class="diagram-container">
      {live}
    </div>

    <h2>The agent</h2>
    <p class="subtitle">Perception, decision, action, approval, effect. OpenCV 5 re-looks at what the detector wasn't sure of; Nemotron VL and the planner turn it into proposals; nothing happens until a person approves, and every step is in the trace.</p>
    <div class="diagram-container">
      {agent}
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-header"><span class="card-dot coral"></span><h3>Why tiles</h3></div>
        <p>A person is about 70 px wide in a 4000×3000 photo. Shrinking the photo to the model's input loses them, so the detector trains and runs on overlapping 1024 px tiles at full resolution. Tiling takes fine-tuned recall from 0.234 to 0.864 on the test set.</p>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-dot ink"></span><h3>Honest by construction</h3></div>
        <ul>
          <li>The threshold is chosen on validation, never on test</li>
          <li>Ground truth never enters the cache</li>
          <li>Every cache file is checked against contract 1.1</li>
          <li>Simulated parts are labelled on screen</li>
        </ul>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-dot muted"></span><h3>Where the numbers come from</h3></div>
        <p>metrics.json (HERIDAL test set, 101 photos, 337 people; demo ranking), the weights-v2 release, and scripts/README.md. Limits and failure cases: docs/DETECTOR_LIMITS.md.</p>
      </div>
    </div>

    <div class="footer">
      <span>sightline · architecture</span>
      <span>drawn to the diagram design rules (MIT, cathrynlavery/diagram-design)</span>
    </div>
  </div>
</body>
</html>
"""


def main() -> None:
    html = PAGE.format(
        font=FONT,
        paper=PAPER,
        paper2=PAPER2,
        ink=INK,
        muted=MUTED,
        soft=SOFT,
        accent=ACCENT,
        system=system(),
        ml=ml(),
        agent=agent(),
        live=live(),
    )
    OUT.write_text(html, encoding="utf-8")
    print(OUT)


main()

# Fleet evaluation v2: coordination under realistic conditions (simulated)

**Simulated evaluation, not a field test.** Three simulated drones search the demo mission's 1 km grid
(200 × 200 cells of 5 m, 16 lattice sectors) from the last known point. Each trial draws the person's
cell from the prior (the ground truth, never shown to the planner) and their visibility; the time to
find is when the photo that finds them **reaches the mission**. 2000 trials per row and seed, seeds 1–5,
visibility noise 0.15, 2 h horizon. Reproduce with `uv run python scripts/fleet_eval.py` (writes
`runs/fleet_eval_v2/result.json`; about 2 minutes on a laptop CPU).

Strategies (`sightline/search/planner_sim.py` `plan_fleet`):

- **coordinated**: the planner on one expected map shared by the fleet (Sightline's design);
- **hand-split**: the fixed serpentine sector order cut into three runs, one per drone;
- **independent**: the same planner on each drone's own map, unaware of the others.

Realism presets (`scripts/fleet_eval.py` `PRESETS`) change how the same plans are flown:

| Preset | Wind | Battery (DJI Mavic 3 Enterprise, 20 % reserve) | GPS cross-track σ | Photo upload loss | Link outages |
|---|---|---|---|---|---|
| ideal | none | not limited | 0 | 0 | none |
| realistic | 6 m/s, random direction; airspeed 9 m/s | 36 min per battery, 6 min swap | 2.5 m | 2 %, retried after 1 min | 1 per hour per drone, 3 min |
| harsh | 10 m/s (under the 12 m/s limit); airspeed 13 m/s | 32 min per battery, 6 min swap | 6 m | 10 %, retried after 1 min | 2 per hour per drone, 8 min |

Endurance and the wind limit are DJI's published numbers (45 min at 9 m/s, 38 min hovering, 12 m/s;
https://enterprise.dji.com/mavic-3-enterprise/specs) through `sightline/search/fleet.py` `Airframe`.
The wind, GPS, packet-loss and outage values are **assumptions** chosen to span a calm day to a bad one,
not measurements. Photos taken during an outage reach the mission when the link is back, as the fleet
simulator buffers them.

## Results

| Preset | Scenario | Strategy | Median min to find | P90 | Found within 30 min (seed range) | Found within 2 h |
|---|---|---|---|---|---|---|
| ideal | no clue | coordinated | 83 | > 2 h | 20.3% (20.0%–20.8%) | 63.3% |
| ideal | no clue | hand-split | 84 | > 2 h | 19.6% (17.9%–21.8%) | 62.4% |
| ideal | no clue | independent | > 2 h | > 2 h | 12.9% (11.8%–14.2%) | 48.6% |
| ideal | a clue at the start (100 m), each sector in turn | coordinated | 79 | > 2 h | 22.7% (22.3%–23.3%) | 63.3% |
| ideal | a clue at the start (100 m), each sector in turn | hand-split | 87 | > 2 h | 20.0% (18.8%–21.5%) | 61.0% |
| ideal | a clue at the start (100 m), each sector in turn | independent | > 2 h | > 2 h | 15.1% (13.6%–16.2%) | 49.6% |
| realistic | no clue | coordinated | > 2 h | > 2 h | 14.5% (13.6%–15.2%) | 46.2% |
| realistic | no clue | hand-split | > 2 h | > 2 h | 14.5% (13.1%–16.4%) | 44.9% |
| realistic | no clue | independent | > 2 h | > 2 h | 9.1% (8.3%–10.1%) | 31.5% |
| realistic | a clue at the start (100 m), each sector in turn | coordinated | > 2 h | > 2 h | 15.9% (14.2%–17.7%) | 41.9% |
| realistic | a clue at the start (100 m), each sector in turn | hand-split | > 2 h | > 2 h | 11.5% (10.6%–12.5%) | 40.5% |
| realistic | a clue at the start (100 m), each sector in turn | independent | > 2 h | > 2 h | 11.5% (10.3%–12.3%) | 31.5% |
| harsh | no clue | coordinated | > 2 h | > 2 h | 12.2% (11.5%–13.1%) | 43.0% |
| harsh | no clue | hand-split | > 2 h | > 2 h | 12.5% (11.3%–14.0%) | 43.0% |
| harsh | no clue | independent | > 2 h | > 2 h | 8.2% (7.2%–9.0%) | 33.5% |
| harsh | a clue at the start (100 m), each sector in turn | coordinated | > 2 h | > 2 h | 13.5% (12.4%–14.5%) | 38.8% |
| harsh | a clue at the start (100 m), each sector in turn | hand-split | > 2 h | > 2 h | 10.0% (8.5%–11.5%) | 36.3% |
| harsh | a clue at the start (100 m), each sector in turn | independent | > 2 h | > 2 h | 10.7% (9.7%–11.8%) | 30.8% |

## What it says

- **With a clue, coordination keeps its lead as conditions get worse**: in the first 30 minutes the
  shared map finds the person in 22.7 % vs 20.0 % of trials for the hand split (ideal), 15.9 % vs
  11.5 % (realistic) and 13.5 % vs 10.0 % (harsh). The seed ranges do not overlap in the realistic and
  harsh rows. A shared map sends the next free drone to where the clue put the probability; a fixed
  split can only reach that sector when its turn comes.
- **With no clue (flat placeholder prior), coordinated and hand-split are level** in every preset:
  with nothing to steer by, a well-made split is as good as a plan. We do not claim a gain there.
- **Planning without sharing is the worst option every time** (independent): three drones on their own
  maps fly the same high-value sectors.
- **Realism costs about a third of the early finds** (ideal → realistic: 20 % → 14.5 % within 30 min,
  no clue), mostly from wind-stretched legs and battery swaps; harsh costs little more because the
  drones fly faster in strong wind (13 m/s airspeed), which this model does not penalise with motion
  blur.

## Limits

- The plans are made for calm air and then flown in the preset's conditions; a real planner would
  re-plan around wind, swaps and outages (it would do better than shown).
- Canopy is unknown (0.5) everywhere: the demo cache's measured canopy comes from HERIDAL **test**
  photos, so it is not used here (val only). The prior is the cache's uniform placeholder.
- No ground teams, no motion blur, no terrain or obstacles; one steady wind per run.
- `runs/fleet_eval/` (v1) used the demo cache's canopy and found coordinated 20.9 % vs hand-split
  20.0 % vs independent 12.1 % within 30 min with no clue; v2's ideal row is the same model without
  that canopy.

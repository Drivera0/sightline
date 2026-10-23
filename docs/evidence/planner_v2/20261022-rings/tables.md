Simulated evaluation · 200×200 cells of 5 m at the creek LKP · canopy /home/driver/sightline/runs/creek/20261021-204123/missions/c797e96a: 7761 cells measured on val crops · noise 0.15 · 120 min

| Study | Scenario | Drones | Variant | Median min | Found ≤ 30 min (seed range) | Found ≤ 2 h |
|---|---|---|---|---|---|---|
| a | person from hiker/temperate_mountainous rings | 1 | planner believes uniform | > 2 h | 8.3% (7.2%–9.4%) | 28.0% |
| a | person from hiker/temperate_mountainous rings | 1 | planner believes Koester 0.8 blend | > 2 h | 8.7% (7.6%–9.6%) | 30.9% |
| a | person from hiker/temperate_mountainous rings | 3 | planner believes uniform | 78 | 22.3% (21.1%–23.9%) | 64.3% |
| a | person from hiker/temperate_mountainous rings | 3 | planner believes Koester 0.8 blend | 76 | 25.9% (24.6%–27.2%) | 65.3% |
| a | person from dementia/temperate_mountainous rings | 1 | planner believes uniform | > 2 h | 10.3% (9.3%–11.0%) | 24.5% |
| a | person from dementia/temperate_mountainous rings | 1 | planner believes Koester 0.8 blend | 95 | 18.2% (17.0%–19.9%) | 54.9% |
| a | person from dementia/temperate_mountainous rings | 3 | planner believes uniform | 76 | 23.1% (22.9%–23.4%) | 62.8% |
| a | person from dementia/temperate_mountainous rings | 3 | planner believes Koester 0.8 blend | 30 | 50.0% (48.3%–51.2%) | 76.0% |
| a | person uniform (category wrong) | 3 | planner believes uniform (dementia/temperate_mountainous) | 78 | 21.9% (20.9%–23.5%) | 64.9% |
| a | person uniform (category wrong) | 3 | planner believes Koester 0.8 blend (dementia/temperate_mountainous) | 95 | 15.3% (14.3%–16.1%) | 57.6% |
| b | val canopy, no clue | 3 | v1: teams ignored by drones, nearest team | 71 | 24.1% (23.0%–24.8%) | 69.1% |
| b | val canopy, a clue at minute 0 in each sector | 3 | v1: teams ignored by drones, nearest team | 68 | 26.3% (26.1%–27.0%) | 69.4% |
| b | val canopy, no clue | 3 | drone discount only | 69 | 24.3% (23.2%–25.3%) | 68.8% |
| b | val canopy, a clue at minute 0 in each sector | 3 | drone discount only | 67 | 26.4% (25.3%–27.7%) | 68.6% |
| b | val canopy, no clue | 3 | walking time only | 69 | 24.0% (23.0%–25.4%) | 69.8% |
| b | val canopy, a clue at minute 0 in each sector | 3 | walking time only | 68 | 26.7% (25.9%–27.4%) | 68.9% |
| b | val canopy, no clue | 3 | v2: discount 0.5 + walking time | 67 | 25.3% (24.5%–25.9%) | 69.9% |
| b | val canopy, a clue at minute 0 in each sector | 3 | v2: discount 0.5 + walking time | 67 | 27.1% (26.6%–27.9%) | 69.6% |
| b | synthetic sector canopy, no clue | 3 | v1: teams ignored by drones, nearest team | 57 | 34.8% (32.7%–37.8%) | 69.8% |
| b | synthetic sector canopy, a clue at minute 0 in each sector | 3 | v1: teams ignored by drones, nearest team | 57 | 34.1% (32.5%–36.6%) | 69.8% |
| b | synthetic sector canopy, no clue | 3 | drone discount only | 58 | 34.7% (33.9%–37.1%) | 71.2% |
| b | synthetic sector canopy, a clue at minute 0 in each sector | 3 | drone discount only | 55 | 34.5% (32.0%–36.5%) | 71.1% |
| b | synthetic sector canopy, no clue | 3 | walking time only | 57 | 34.5% (32.6%–36.3%) | 70.1% |
| b | synthetic sector canopy, a clue at minute 0 in each sector | 3 | walking time only | 57 | 34.1% (32.4%–36.3%) | 69.8% |
| b | synthetic sector canopy, no clue | 3 | v2: discount 0.5 + walking time | 58 | 34.6% (33.6%–35.9%) | 71.9% |
| b | synthetic sector canopy, a clue at minute 0 in each sector | 3 | v2: discount 0.5 + walking time | 56 | 34.4% (31.9%–36.1%) | 70.9% |
| c | no opening legs, clue at minute 0 | 3 | best leg only (v1) | > 2 h | 13.5% (13.2%–13.7%) | 46.3% |
| c | no opening legs, clue at minute 0 | 3 | best leg + every idle drone (v2) | 67 | 27.1% (26.3%–27.4%) | 69.6% |
| c | opening legs, clue at minute 0 | 3 | best leg only (v1) | 67 | 27.1% (26.6%–27.9%) | 69.6% |
| c | opening legs, clue at minute 0 | 3 | best leg + every idle drone (v2) | 67 | 27.1% (26.6%–27.9%) | 69.6% |
| c | opening legs, clue at minute 10 | 3 | best leg only (v1) | 68 | 26.6% (25.0%–27.3%) | 69.5% |
| c | opening legs, clue at minute 10 | 3 | best leg + every idle drone (v2) | 68 | 26.6% (25.0%–27.3%) | 69.5% |

2000 trials per row and seed, 5 seeds; 72.8 s (the falloff rings, RING_EDGE 0.25; same seeds and canopy as 20261022-0157)

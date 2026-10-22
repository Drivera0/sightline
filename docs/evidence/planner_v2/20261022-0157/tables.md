Simulated evaluation · 200×200 cells of 5 m at the creek LKP · canopy /home/driver/sightline/runs/creek/20261021-204123/missions/c797e96a: 7761 cells measured on val crops · noise 0.15 · 120 min

| Study | Scenario | Drones | Variant | Median min | Found ≤ 30 min (seed range) | Found ≤ 2 h |
|---|---|---|---|---|---|---|
| a | person from hiker/temperate_mountainous rings | 1 | planner believes uniform | > 2 h | 7.9% (7.3%–8.9%) | 27.8% |
| a | person from hiker/temperate_mountainous rings | 1 | planner believes Koester 0.8 blend | > 2 h | 7.9% (7.3%–8.9%) | 27.8% |
| a | person from hiker/temperate_mountainous rings | 3 | planner believes uniform | 78 | 21.4% (20.4%–22.6%) | 64.7% |
| a | person from hiker/temperate_mountainous rings | 3 | planner believes Koester 0.8 blend | 78 | 21.4% (20.4%–22.6%) | 64.7% |
| a | person from dementia/temperate_mountainous rings | 1 | planner believes uniform | > 2 h | 9.9% (9.2%–11.2%) | 24.2% |
| a | person from dementia/temperate_mountainous rings | 1 | planner believes Koester 0.8 blend | 85 | 18.7% (17.5%–19.9%) | 58.3% |
| a | person from dementia/temperate_mountainous rings | 3 | planner believes uniform | 75 | 22.1% (20.9%–23.1%) | 62.1% |
| a | person from dementia/temperate_mountainous rings | 3 | planner believes Koester 0.8 blend | 28 | 52.8% (52.0%–53.2%) | 79.1% |
| a | person uniform (category wrong) | 3 | planner believes uniform (dementia/temperate_mountainous) | 78 | 21.9% (20.9%–23.5%) | 64.9% |
| a | person uniform (category wrong) | 3 | planner believes Koester 0.8 blend (dementia/temperate_mountainous) | 101 | 15.7% (14.9%–17.0%) | 55.8% |
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

2000 trials per row and seed, 5 seeds; 353.3 s; wrote /home/driver/sightline/.claude/worktrees/agent-a5bbaa9436c0b9fd4/runs/planner_v2/result.json
wall 332.29 s, max RSS 376740 kB

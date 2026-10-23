Simulated evaluation · 200×200 cells of 5 m at the creek LKP · canopy runs/creek/20261021-204123/missions/c797e96a: 7761 cells measured on val crops · noise 0.15 · 120 min

| Study | Scenario | Drones | Variant | Median min | Found ≤ 30 min (seed range) | Found ≤ 2 h |
|---|---|---|---|---|---|---|
| d | person from hiker/temperate_mountainous rings × terrain | 1 | planner believes Koester 0.8 blend | > 2 h | 9.3% (8.5%–10.6%) | 32.2% |
| d | person from hiker/temperate_mountainous rings × terrain | 1 | planner believes Koester 0.8 blend × terrain | > 2 h | 11.8% (11.4%–12.3%) | 33.7% |
| d | person from hiker/temperate_mountainous rings × terrain | 3 | planner believes Koester 0.8 blend | 74 | 26.9% (25.7%–28.1%) | 65.9% |
| d | person from hiker/temperate_mountainous rings × terrain | 3 | planner believes Koester 0.8 blend × terrain | 73 | 26.8% (25.5%–29.3%) | 66.2% |
| d | person from hiker/temperate_mountainous rings only | 1 | planner believes Koester 0.8 blend | > 2 h | 8.7% (7.6%–9.6%) | 30.9% |
| d | person from hiker/temperate_mountainous rings only | 1 | planner believes Koester 0.8 blend × terrain | > 2 h | 8.5% (7.6%–9.7%) | 29.1% |
| d | person from hiker/temperate_mountainous rings only | 3 | planner believes Koester 0.8 blend | 76 | 25.9% (24.6%–27.2%) | 65.3% |
| d | person from hiker/temperate_mountainous rings only | 3 | planner believes Koester 0.8 blend × terrain | 81 | 22.5% (22.2%–23.0%) | 64.0% |
| d | person from dementia/temperate_mountainous rings × terrain | 1 | planner believes Koester 0.8 blend | 86 | 20.7% (19.3%–21.7%) | 59.3% |
| d | person from dementia/temperate_mountainous rings × terrain | 1 | planner believes Koester 0.8 blend × terrain | 83 | 22.4% (21.1%–23.6%) | 59.3% |
| d | person from dementia/temperate_mountainous rings × terrain | 3 | planner believes Koester 0.8 blend | 27 | 53.8% (52.5%–54.9%) | 77.8% |
| d | person from dementia/temperate_mountainous rings × terrain | 3 | planner believes Koester 0.8 blend × terrain | 26 | 53.6% (52.3%–54.9%) | 78.4% |
| d | person from dementia/temperate_mountainous rings only | 1 | planner believes Koester 0.8 blend | 95 | 18.2% (17.0%–19.9%) | 54.9% |
| d | person from dementia/temperate_mountainous rings only | 1 | planner believes Koester 0.8 blend × terrain | 94 | 19.0% (17.2%–20.6%) | 54.7% |
| d | person from dementia/temperate_mountainous rings only | 3 | planner believes Koester 0.8 blend | 30 | 50.0% (48.3%–51.2%) | 76.0% |
| d | person from dementia/temperate_mountainous rings only | 3 | planner believes Koester 0.8 blend × terrain | 31 | 49.5% (48.1%–50.1%) | 75.7% |

2000 trials per row and seed, 5 seeds; 3.5 s; wrote runs/planner_v2_affinity/result.json

Demo prior (hiker/temperate_mountainous rings, demo map LKP 49.37, -122.945), 4 × 4 sector POA without and with the terrain affinity:

outside: 0.7467 before, 0.7467 after; in-grid 0.2533 both

| Sector | POA rings | POA rings × terrain | Change | Mean multiplier |
|---|---|---|---|---|
| B2 | 1.92% | 2.43% | +0.51 pt | 1.26 |
| B3 | 1.92% | 2.14% | +0.22 pt | 1.12 |
| D3 | 1.55% | 1.84% | +0.29 pt | 1.20 |
| A3 | 1.55% | 1.77% | +0.22 pt | 1.13 |
| C4 | 1.55% | 1.74% | +0.19 pt | 1.12 |
| C3 | 1.92% | 1.73% | -0.19 pt | 0.92 |
| A1 | 1.32% | 1.64% | +0.32 pt | 1.24 |
| A2 | 1.55% | 1.63% | +0.08 pt | 1.04 |
| C1 | 1.55% | 1.62% | +0.07 pt | 1.04 |
| B1 | 1.55% | 1.58% | +0.03 pt | 1.01 |
| D4 | 1.32% | 1.54% | +0.22 pt | 1.16 |
| B4 | 1.55% | 1.42% | -0.13 pt | 0.90 |
| C2 | 1.92% | 1.33% | -0.59 pt | 0.70 |
| A4 | 1.32% | 1.02% | -0.30 pt | 0.79 |
| D1 | 1.32% | 1.00% | -0.31 pt | 0.75 |
| D2 | 1.55% | 0.93% | -0.62 pt | 0.61 |

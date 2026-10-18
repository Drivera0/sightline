import { describe, expect, it } from "vitest";
import type { Detections, Survey } from "../../contract";
import {
  buildDetectionFeatures,
  buildPinMarkerFeatures,
  buildFlightDirectionFeatures,
  buildFlightPathFeature,
  buildFootprintFeatures,
  buildGridOutlineFeature,
  buildLkpFeature,
  gridBounds,
  surveyBounds,
  viewBounds,
} from "./features";

const survey: Survey = {
  contract_version: "1.0",
  survey_id: "test",
  simulated_path: true,
  area: { name: "Test", lkp: { lat: 49.37, lon: -122.945 } },
  frames: [
    {
      id: "f0001",
      file: "frames/f0001.jpg",
      width_px: 1000,
      height_px: 750,
      flight_index: 0,
      source: { image: "source.jpg", x0: 0, y0: 0 },
      pose: { lat: 49.37, lon: -122.946, alt_agl_m: null, heading_deg: 90, gsd_m: 0.02 },
      footprint: [
        [-122.9461, 49.3701],
        [-122.9459, 49.3701],
        [-122.9459, 49.3699],
        [-122.9461, 49.3699],
      ],
      score: 0.8,
      rank: 1,
      n_candidates: 1,
    },
    {
      id: "f0002",
      file: "frames/f0002.jpg",
      width_px: 1000,
      height_px: 750,
      flight_index: 1,
      source: { image: "source.jpg", x0: 0, y0: 0 },
      pose: { lat: 49.37, lon: -122.944, alt_agl_m: null, heading_deg: 90, gsd_m: 0.02 },
      footprint: [
        [-122.9441, 49.3701],
        [-122.9439, 49.3701],
        [-122.9439, 49.3699],
        [-122.9441, 49.3699],
      ],
      score: 0.2,
      rank: 2,
      n_candidates: 0,
    },
  ],
};

const detections: Detections = {
  contract_version: "1.0",
  model: "test",
  save_threshold: 0.05,
  candidate_threshold: 0.25,
  frames: {
    f0001: [
      {
        id: "f0001-d01",
        box_px: [1, 2, 3, 4],
        conf: 0.8,
        crop: "crops/f0001-d01.jpg",
        lat: 49.37,
        lon: -122.946,
        radius_m: 10,
      },
    ],
    f0002: [
      {
        id: "f0002-d01",
        box_px: [1, 2, 3, 4],
        conf: 0.1,
        crop: null,
        lat: 49.37,
        lon: -122.944,
        radius_m: 10,
      },
    ],
  },
};

describe("base map GeoJSON", () => {
  it("closes every contract footprint for GeoJSON", () => {
    const collection = buildFootprintFeatures(survey);

    expect(collection.features).toHaveLength(2);
    const ring = collection.features[0]?.geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring?.at(-1)).toEqual(ring?.[0]);
  });

  it("orders the flight path by flight index", () => {
    const feature = buildFlightPathFeature(survey);

    expect(feature.geometry.coordinates).toEqual([
      [-122.946, 49.37],
      [-122.944, 49.37],
    ]);
  });

  it("does not invent a flight line between real-position source photos", () => {
    const realSurvey = { ...survey, simulated_path: false };

    expect(buildFlightPathFeature(realSurvey).geometry.coordinates).toEqual([]);
    expect(buildFlightDirectionFeatures(realSurvey).features).toEqual([]);
    expect(buildLkpFeature(realSurvey).properties.label).toBe("Survey centre");
  });

  it("builds flight-direction chevrons from each sampled frame heading", () => {
    const collection = buildFlightDirectionFeatures(survey, 1);

    expect(collection.features).toHaveLength(2);
    expect(collection.features[0]?.geometry.coordinates).toHaveLength(2);
    const firstArrow = collection.features[0]?.geometry.coordinates;
    const tipLon = firstArrow?.[0]?.[1]?.[0];
    const leftTailLon = firstArrow?.[0]?.[0]?.[0];
    const rightTailLon = firstArrow?.[1]?.[0]?.[0];
    if (tipLon === undefined || leftTailLon === undefined || rightTailLon === undefined) {
      throw new Error("Direction chevron coordinates are incomplete");
    }
    expect(tipLon).toBeGreaterThan(Math.max(leftTailLon, rightTailLon));
  });

  it("converts the contract grid dimensions into a closed outline", () => {
    const grid = {
      origin_nw: { lat: 49, lon: -123 },
      cell_m: 20,
      rows: 2,
      cols: 3,
    };
    const feature = buildGridOutlineFeature(grid);

    expect(feature.geometry.coordinates).toHaveLength(5);
    expect(feature.geometry.coordinates.at(-1)).toEqual(feature.geometry.coordinates[0]);
    expect(feature.geometry.coordinates[1]?.[0]).toBeCloseTo(
      -123 + 60 / (111_320 * Math.cos((49 * Math.PI) / 180)),
    );
    expect(feature.geometry.coordinates[2]?.[1]).toBeCloseTo(49 - 40 / 111_320);
    expect(gridBounds(grid)).toEqual([
      feature.geometry.coordinates[3],
      feature.geometry.coordinates[1],
    ]);
  });

  it("only maps detections at or above the candidate threshold", () => {
    const collection = buildDetectionFeatures(detections);

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties.detectionId).toBe("f0001-d01");
    expect(collection.features[0]?.properties.reviewState).toBe("unreviewed");
    expect(collection.features[0]?.geometry.coordinates[0]).toHaveLength(65);
  });

  it("adds every review state and its visible label to detection features", () => {
    const reviewedDetections: Detections = {
      ...detections,
      frames: {
        f0001: [
          detections.frames.f0001![0]!,
          { ...detections.frames.f0001![0]!, id: "f0001-d02" },
          { ...detections.frames.f0001![0]!, id: "f0001-d03" },
          { ...detections.frames.f0001![0]!, id: "f0001-d04" },
        ],
      },
    };

    const collection = buildDetectionFeatures(reviewedDetections, {
      "f0001-d02": "person",
      "f0001-d03": "not_person",
      "f0001-d04": "unsure",
    });

    expect(collection.features.map((feature) => feature.properties.reviewState)).toEqual([
      "unreviewed",
      "person",
      "not_person",
      "unsure",
    ]);
    expect(collection.features.map((feature) => feature.properties.reviewLabel)).toEqual([
      "",
      "Person confirmed",
      "",
      "Unsure · check again",
    ]);

    // One centre point per candidate for the icon and chip; a person's label wins a collision.
    const markers = buildPinMarkerFeatures(reviewedDetections, {
      "f0001-d02": "person",
      "f0001-d04": "unsure",
    });
    expect(markers.features.map((f) => f.geometry.coordinates)).toEqual(
      reviewedDetections.frames.f0001!.map((d) => [d.lon, d.lat]),
    );
    expect(markers.features.map((f) => f.properties.labelRank)).toEqual([1, 0, 1, 1]);
  });

  it("uses the survey last-known point", () => {
    expect(buildLkpFeature(survey).geometry.coordinates).toEqual([-122.945, 49.37]);
  });

  it("bounds the complete surveyed area", () => {
    expect(surveyBounds(survey)).toEqual([
      [-122.9461, 49.3699],
      [-122.9439, 49.3701],
    ]);
  });

  it("frames simulated surveys by grid and real-position surveys by footprints", () => {
    const grid = {
      origin_nw: { lat: 49, lon: -123 },
      cell_m: 20,
      rows: 2,
      cols: 3,
    };

    expect(viewBounds(survey, grid)).toEqual(gridBounds(grid));
    expect(viewBounds({ ...survey, simulated_path: false }, grid)).toEqual(
      surveyBounds(survey),
    );
  });
});

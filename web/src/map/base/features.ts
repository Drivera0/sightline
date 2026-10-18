import type { Detections, Grid, Survey } from "../../contract";
import type { Answer } from "../../review/store";
import { circlePolygon, type PolygonGeometry } from "./circle";

interface Feature<G, P> {
  type: "Feature";
  geometry: G;
  properties: P;
}

interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

interface LineStringGeometry {
  type: "LineString";
  coordinates: number[][];
}

interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: number[][][];
}

interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

interface FootprintProperties {
  frameId: string;
  flightIndex: number;
}

interface DetectionProperties {
  detectionId: string;
  frameId: string;
  confidence: number;
  radiusM: number;
  reviewState: Answer | "unreviewed";
  reviewLabel: ReviewLabel;
}

/** Words, not a bare "?": the chip says what the answer means for the search. */
export type ReviewLabel = "Person confirmed" | "Unsure · check again" | "";

export function reviewLabelFor(state: Answer | "unreviewed"): ReviewLabel {
  if (state === "person") return "Person confirmed";
  if (state === "unsure") return "Unsure · check again";
  return "";
}

interface PinMarkerProperties {
  detectionId: string;
  frameId: string;
  reviewState: Answer | "unreviewed";
  reviewLabel: ReviewLabel;
  /** Person first, then unsure: which label wins when two would collide. */
  labelRank: number;
}

const METRES_PER_DEGREE = 111_320;

// Offset a longitude/latitude coordinate by local east/north distances in metres.
function offsetCoordinate(
  lon: number,
  lat: number,
  eastM: number,
  northM: number,
): [number, number] {
  return [
    lon + eastM / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)),
    lat + northM / METRES_PER_DEGREE,
  ];
}

// Convert contract footprints into closed GeoJSON polygon features.
export function buildFootprintFeatures(
  survey: Survey,
): FeatureCollection<Feature<PolygonGeometry, FootprintProperties>> {
  return {
    type: "FeatureCollection",
    features: survey.frames.map((frame) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[...frame.footprint, frame.footprint[0]]],
      },
      properties: { frameId: frame.id, flightIndex: frame.flight_index },
    })),
  };
}

// Join frame centres in flight order to form the displayed survey path.
export function buildFlightPathFeature(
  survey: Survey,
): Feature<LineStringGeometry, Record<string, never>> {
  if (!survey.simulated_path) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [] },
      properties: {},
    };
  }
  const orderedFrames = [...survey.frames].sort((left, right) => {
    return left.flight_index - right.flight_index;
  });
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: orderedFrames.map((frame) => [frame.pose.lon, frame.pose.lat]),
    },
    properties: {},
  };
}

// Draw small line-based chevrons along the path without relying on online icon assets.
export function buildFlightDirectionFeatures(
  survey: Survey,
  everyFrames = 5,
): FeatureCollection<Feature<MultiLineStringGeometry, { frameId: string }>> {
  if (!Number.isInteger(everyFrames) || everyFrames < 1) {
    throw new RangeError("everyFrames must be a positive integer");
  }
  if (!survey.simulated_path) return { type: "FeatureCollection", features: [] };
  const orderedFrames = [...survey.frames].sort((left, right) => {
    return left.flight_index - right.flight_index;
  });
  return {
    type: "FeatureCollection",
    features: orderedFrames
      .filter((_, index) => index % everyFrames === 0)
      .map((frame) => {
        const headingRad = (frame.pose.heading_deg * Math.PI) / 180;
        const forwardEast = Math.sin(headingRad);
        const forwardNorth = Math.cos(headingRad);
        const rightEast = Math.cos(headingRad);
        const rightNorth = -Math.sin(headingRad);
        const tip = offsetCoordinate(
          frame.pose.lon,
          frame.pose.lat,
          forwardEast * 3,
          forwardNorth * 3,
        );
        const leftTail = offsetCoordinate(
          frame.pose.lon,
          frame.pose.lat,
          -forwardEast * 3 - rightEast * 2,
          -forwardNorth * 3 - rightNorth * 2,
        );
        const rightTail = offsetCoordinate(
          frame.pose.lon,
          frame.pose.lat,
          -forwardEast * 3 + rightEast * 2,
          -forwardNorth * 3 + rightNorth * 2,
        );
        return {
          type: "Feature",
          geometry: { type: "MultiLineString", coordinates: [[leftTail, tip], [rightTail, tip]] },
          properties: { frameId: frame.id },
        };
      }),
  };
}

// Convert the contract's north-west grid origin and metre dimensions into a closed outline.
export function buildGridOutlineFeature(
  grid: Grid,
): Feature<LineStringGeometry, Record<string, never>> {
  const northWest: [number, number] = [grid.origin_nw.lon, grid.origin_nw.lat];
  const northEast = offsetCoordinate(
    grid.origin_nw.lon,
    grid.origin_nw.lat,
    grid.cols * grid.cell_m,
    0,
  );
  const southEast = offsetCoordinate(
    grid.origin_nw.lon,
    grid.origin_nw.lat,
    grid.cols * grid.cell_m,
    -grid.rows * grid.cell_m,
  );
  const southWest = offsetCoordinate(
    grid.origin_nw.lon,
    grid.origin_nw.lat,
    0,
    -grid.rows * grid.cell_m,
  );
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [northWest, northEast, southEast, southWest, northWest],
    },
    properties: {},
  };
}

// Return south-west and north-east corners for framing the complete search grid.
export function gridBounds(grid: Grid): [[number, number], [number, number]] {
  const outline = buildGridOutlineFeature(grid).geometry.coordinates;
  return [outline[3] as [number, number], outline[1] as [number, number]];
}

// Build metre-scaled polygons for candidate detections only.
export function buildDetectionFeatures(
  detections: Detections,
  answers: Readonly<Record<string, Answer>> = {},
): FeatureCollection<Feature<PolygonGeometry, DetectionProperties>> {
  const features: Feature<PolygonGeometry, DetectionProperties>[] = [];
  for (const [frameId, frameDetections] of Object.entries(detections.frames)) {
    for (const detection of frameDetections) {
      if (detection.conf < detections.candidate_threshold) continue;
      const reviewState = answers[detection.id] ?? "unreviewed";
      features.push({
        type: "Feature",
        geometry: circlePolygon(detection.lon, detection.lat, detection.radius_m),
        properties: {
          detectionId: detection.id,
          frameId,
          confidence: detection.conf,
          radiusM: detection.radius_m,
          reviewState,
          reviewLabel: reviewLabelFor(reviewState),
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

// One point per candidate at its centre, carrying the state icon and its label chip.
export function buildPinMarkerFeatures(
  detections: Detections,
  answers: Readonly<Record<string, Answer>> = {},
): FeatureCollection<Feature<PointGeometry, PinMarkerProperties>> {
  const features: Feature<PointGeometry, PinMarkerProperties>[] = [];
  for (const [frameId, frameDetections] of Object.entries(detections.frames)) {
    for (const detection of frameDetections) {
      if (detection.conf < detections.candidate_threshold) continue;
      const reviewState = answers[detection.id] ?? "unreviewed";
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [detection.lon, detection.lat] },
        properties: {
          detectionId: detection.id,
          frameId,
          reviewState,
          reviewLabel: reviewLabelFor(reviewState),
          labelRank: reviewState === "person" ? 0 : 1,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

// Represent the survey's last-known point as one GeoJSON point feature.
export function buildLkpFeature(
  survey: Survey,
): Feature<PointGeometry, { label: string }> {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [survey.area.lkp.lon, survey.area.lkp.lat],
    },
    properties: { label: survey.simulated_path ? "Last known point" : "Survey centre" },
  };
}

// Find a bounding box around every frame footprint for survey-focused views.
export function surveyBounds(survey: Survey): [[number, number], [number, number]] | null {
  const coordinates = survey.frames.flatMap((frame) => frame.footprint);
  if (coordinates.length === 0) return null;

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of coordinates) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

// Frame simulated searches by their grid, but frame real-position surveys by actual footprints.
export function viewBounds(
  survey: Survey,
  grid: Grid,
): [[number, number], [number, number]] {
  if (survey.simulated_path) return gridBounds(grid);
  return surveyBounds(survey) ?? gridBounds(grid);
}

import type { Detections, Survey } from "../../contract";
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

// Build metre-scaled polygons for candidate detections only.
export function buildDetectionFeatures(
  detections: Detections,
): FeatureCollection<Feature<PolygonGeometry, DetectionProperties>> {
  const features: Feature<PolygonGeometry, DetectionProperties>[] = [];
  for (const [frameId, frameDetections] of Object.entries(detections.frames)) {
    for (const detection of frameDetections) {
      if (detection.conf < detections.candidate_threshold) continue;
      features.push({
        type: "Feature",
        geometry: circlePolygon(detection.lon, detection.lat, detection.radius_m),
        properties: {
          detectionId: detection.id,
          frameId,
          confidence: detection.conf,
          radiusM: detection.radius_m,
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
    properties: { label: "Last known point" },
  };
}

// Find a bounding box around every frame footprint for the initial camera view.
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

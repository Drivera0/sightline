const EARTH_RADIUS_M = 6_371_008.8;

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

// Approximate a metre-scaled uncertainty circle as a closed GeoJSON polygon.
export function circlePolygon(
  lon: number,
  lat: number,
  radiusM: number,
  points = 64,
): PolygonGeometry {
  if (radiusM < 0) throw new RangeError("radiusM must not be negative");
  if (points < 3) throw new RangeError("points must be at least 3");

  const latitude = degreesToRadians(lat);
  const longitude = degreesToRadians(lon);
  const angularDistance = radiusM / EARTH_RADIUS_M;
  const coordinates: number[][] = [];

  for (let index = 0; index <= points; index += 1) {
    const bearing = (index / points) * 2 * Math.PI;
    const circleLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const circleLongitude =
      longitude +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(circleLatitude),
      );
    coordinates.push([
      radiansToDegrees(circleLongitude),
      radiansToDegrees(circleLatitude),
    ]);
  }

  return { type: "Polygon", coordinates: [coordinates] };
}

// Convert angle values from degrees to radians for trigonometry.
function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

// Convert calculated angles back into GeoJSON degree coordinates.
function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

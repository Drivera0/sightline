// Shared by lane B's live-mission layers (clueLayer, teamLayer, droneLayer, legLayer): plain GeoJSON
// features the live map draws. `tone` picks a theme colour when the layer is drawn. Built by lane A for
// lane B (#74).
export type Tone = "accent" | "warn" | "ok" | "info" | "muted" | "text";
export interface MissionFeature {
  type: "Feature";
  properties: { kind: string; id: string; label: string; tone: Tone; popup?: string } & Record<string, unknown>;
  geometry: { type: "Point" | "LineString"; coordinates: unknown };
}
export const point = (kind: string, id: string, label: string, tone: Tone, lon: number, lat: number, popup?: string): MissionFeature => ({
  type: "Feature",
  properties: { kind, id, label, tone, ...(popup ? { popup } : {}) },
  geometry: { type: "Point", coordinates: [lon, lat] },
});
export const minutesAgo = (iso: string, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));

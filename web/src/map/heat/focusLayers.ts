// What the search manager is looking at in Needs you, on the map (V3 §2): a candidate in focus has its
// photo's footprint outlined and its pin pulsing in the accent; a proposal in focus has its sector outlined
// in a violet glow; the map pans to keep either in view. When a team is assigned (an approved proposal, the
// sector picker, a drop, the popover) its route grows from where it is (else its last sector, else base
// camp) to the sector in the team colour, holds, and fades. Reduced motion: no pulse, the route drawn whole,
// no pan animation. Built by lane A.
import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { Mission, Proposal, Team } from "../../contract";
import type { SectorNow } from "../../lib/api";
import { useSelection } from "../../lib/selection";
import { prefersReducedMotion } from "../../metrics/motion";
import { useConsole } from "../../command/consoleStore";
import { useLapseBeat } from "../../command/story";
import { partialPath, routeStart, routeTo, type RouteTask } from "../base/teamRoute";
import type { LonLat } from "../base/fleetMotion";

export const FOCUS_ID = "live-heat-focus";
export const ROUTE_ID = "live-heat-route";
/** The route grows over this long, holds, then fades (ms). */
export const ROUTE_GROW_MS = 1600;
export const ROUTE_HOLD_MS = 5000;
export const ROUTE_FADE_MS = 900;
/** The focused pin's pulse: one slow swell (ms). */
export const PULSE_MS = 1600;

export interface CandidatePlace {
  lat: number;
  lon: number;
  /** The photo's footprint on the ground, [lon, lat] corners. */
  footprint?: readonly (readonly [number, number])[] | null;
}

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
const setData = (map: Map, id: string, features: Feature[]) => (map.getSource(id) as GeoJSONSource | undefined)?.setData?.(fc(features) as never);
const cssVar = (name: string, fallback: string) => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

/** A new assignment seen in the mission: who goes where. */
export interface Assignment {
  team: string;
  sector: string;
}

/**
 * The assignments made since the last look: an assign proposal approved (its team, or the one an edit
 * chose), or a task newly assigned to a team. Pure, so the map and the tests agree.
 */
export function newAssignments(
  before: { proposals: readonly Proposal[]; tasks: readonly RouteTask[] } | null,
  now: { proposals: readonly Proposal[]; tasks: readonly RouteTask[] },
): Assignment[] {
  if (!before) return [];
  const out: Assignment[] = [];
  const seen = new Set<string>();
  const add = (team: string | null | undefined, sector: string | null | undefined) => {
    if (!team || !sector || seen.has(`${team}|${sector}`)) return;
    seen.add(`${team}|${sector}`);
    out.push({ team, sector });
  };
  for (const p of now.proposals) {
    if (p.kind !== "assign_sector" || p.status !== "approved") continue;
    if (before.proposals.find((x) => x.id === p.id)?.status !== "pending") continue;
    add(p.edits?.team ?? p.target.team, p.target.sector);
  }
  for (const t of now.tasks) {
    if (t.state !== "assigned" || !t.team_id) continue;
    const was = before.tasks.find((x) => x.sector_id === t.sector_id);
    if (was && was.state === "assigned" && was.team_id === t.team_id) continue;
    add(t.team_id, t.sector_id);
  }
  return out;
}

interface Route {
  key: string;
  path: LonLat[];
  start: number;
}

export function useFocusLayers(
  map: Map | null,
  ready: boolean,
  d: {
    sectors: readonly SectorNow[];
    proposals: readonly Proposal[];
    tasks: readonly RouteTask[];
    teams: readonly Team[];
    mission: Pick<Mission, "base_camp"> | null;
    candidateAt?: (id: string) => CandidatePlace | null;
  },
): void {
  const candidate = useSelection((s) => s.selectedDetectionId);
  const focus = useConsole((s) => s.focus);
  // the layers, once per map
  useEffect(() => {
    if (!map || !ready) return;
    for (const id of [FOCUS_ID, ROUTE_ID]) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: fc([]) as never });
    const violet = cssVar("--proposal", "#a98bff");
    const accent = cssVar("--accent", "#ff7a1a");
    const team = cssVar("--team", "#6aa8ff");
    const add = (layer: Parameters<Map["addLayer"]>[0]) => {
      if (!map.getLayer(layer.id)) map.addLayer(layer, map.getLayer("live-heat-halos") ? "live-heat-halos" : undefined);
    };
    const is = (k: string) => ["==", ["get", "kind"], k] as never;
    add({ id: `${FOCUS_ID}-sector-glow`, type: "line", source: FOCUS_ID, filter: is("sector"), paint: { "line-color": violet, "line-width": 9, "line-blur": 6, "line-opacity": 0.55 } });
    add({ id: `${FOCUS_ID}-sector`, type: "line", source: FOCUS_ID, filter: is("sector"), paint: { "line-color": violet, "line-width": 2.25 } });
    add({ id: `${FOCUS_ID}-foot-fill`, type: "fill", source: FOCUS_ID, filter: is("footprint"), paint: { "fill-color": accent, "fill-opacity": 0.1 } });
    add({ id: `${FOCUS_ID}-foot`, type: "line", source: FOCUS_ID, filter: is("footprint"), paint: { "line-color": accent, "line-width": 1.75, "line-dasharray": [3, 2] } });
    add({ id: `${FOCUS_ID}-pulse`, type: "circle", source: FOCUS_ID, filter: is("pin"), paint: { "circle-radius": 10, "circle-color": accent, "circle-opacity": 0.25, "circle-stroke-color": accent, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.6 } });
    add({ id: `${FOCUS_ID}-pin`, type: "circle", source: FOCUS_ID, filter: is("pin"), paint: { "circle-radius": 5, "circle-color": accent, "circle-stroke-color": cssVar("--bg", "#0a0b0d"), "circle-stroke-width": 2 } });
    add({ id: `${ROUTE_ID}-casing`, type: "line", source: ROUTE_ID, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": cssVar("--bg", "#0a0b0d"), "line-width": 6, "line-opacity": ["get", "a"] as never } });
    add({ id: ROUTE_ID, type: "line", source: ROUTE_ID, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": team, "line-width": 3, "line-opacity": ["get", "a"] as never } });
  }, [map, ready]);

  // the focus: a candidate (the shared selection: the review rail and the review frame set it) or a proposal
  const place = candidate ? (d.candidateAt?.(candidate) ?? null) : null;
  const proposal = focus?.kind === "proposal" ? d.proposals.find((p) => p.id === focus.id && p.status === "pending") : undefined;
  const sectorId = proposal ? (proposal.target.sector ?? proposal.leg?.sector_id ?? null) : null;
  const sector = sectorId ? d.sectors.find((s) => s.sector_id === sectorId) : undefined;
  const key = `${place ? `${candidate}@${place.lat},${place.lon}` : ""}|${sector?.sector_id ?? ""}`;
  useEffect(() => {
    if (!map || !ready) return undefined;
    const features: Feature[] = [];
    if (place?.footprint?.length) {
      const ring = place.footprint.map((p) => [p[0], p[1]]);
      features.push({ type: "Feature", properties: { kind: "footprint" }, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } });
    }
    if (place) features.push({ type: "Feature", properties: { kind: "pin" }, geometry: { type: "Point", coordinates: [place.lon, place.lat] } });
    if (sector?.polygon?.length) features.push({ type: "Feature", properties: { kind: "sector" }, geometry: { type: "LineString", coordinates: sector.polygon } });
    setData(map, FOCUS_ID, features);
    // keep it in view: pan only when it is near or past the edge
    const at: LonLat | null = place ? [place.lon, place.lat] : sector?.polygon?.length ? centreOf(sector.polygon) : null;
    if (at) {
      const c = map.getContainer();
      const p = map.project(at);
      const mx = c.clientWidth * 0.15;
      const my = c.clientHeight * 0.15;
      if (p.x < mx || p.y < my || p.x > c.clientWidth - mx || p.y > c.clientHeight - my) map.easeTo({ center: at, duration: prefersReducedMotion() ? 0 : 600 });
    }
    // the pin's pulse while it is in focus
    if (!place || prefersReducedMotion()) return undefined;
    let raf = 0;
    const start = performance.now();
    const frame = (t: number) => {
      const f = (((t - start) % PULSE_MS) + PULSE_MS) % PULSE_MS / PULSE_MS;
      try {
        map.setPaintProperty(`${FOCUS_ID}-pulse`, "circle-radius", 8 + 14 * f);
        map.setPaintProperty(`${FOCUS_ID}-pulse`, "circle-opacity", 0.3 * (1 - f));
        map.setPaintProperty(`${FOCUS_ID}-pulse`, "circle-stroke-opacity", 0.8 * (1 - f));
      } catch {
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, key]);

  // routes: a new assignment's way to its sector grows, holds and fades
  const before = useRef<{ proposals: readonly Proposal[]; tasks: readonly RouteTask[] } | null>(null);
  const routes = useRef<Route[]>([]);
  const raf = useRef(0);
  useEffect(() => {
    if (!map || !ready) return;
    const fresh = newAssignments(before.current, { proposals: d.proposals, tasks: d.tasks });
    before.current = { proposals: d.proposals, tasks: d.tasks };
    const t0 = performance.now();
    for (const a of fresh) {
      const team = d.teams.find((t) => t.id === a.team);
      const poly = d.sectors.find((s) => s.sector_id === a.sector)?.polygon;
      if (!team || !poly?.length) continue;
      const start = routeStart(team, a.sector, d.tasks, d.sectors, d.mission?.base_camp);
      if (!start) continue;
      const path = [...routeTo(start, poly), centreOf(poly)];
      routes.current = [...routes.current.filter((r) => r.key !== a.team), { key: a.team, path, start: t0 }];
    }
    if (!fresh.length || raf.current) return;
    const reduced = prefersReducedMotion();
    const frame = () => {
      const t = performance.now();
      const life = ROUTE_GROW_MS + ROUTE_HOLD_MS + ROUTE_FADE_MS;
      routes.current = routes.current.filter((r) => t - r.start < life);
      const features: Feature[] = routes.current.map((r) => {
        const age = t - r.start;
        const grow = reduced ? 1 : Math.min(1, age / ROUTE_GROW_MS);
        const fade = age > ROUTE_GROW_MS + ROUTE_HOLD_MS ? 1 - (age - ROUTE_GROW_MS - ROUTE_HOLD_MS) / ROUTE_FADE_MS : 1;
        return { type: "Feature", properties: { a: Math.max(0, 0.95 * fade) }, geometry: { type: "LineString", coordinates: partialPath(r.path, 1 - (1 - grow) ** 2) } };
      });
      try {
        setData(map, ROUTE_ID, features);
      } catch {
        raf.current = 0;
        return;
      }
      raf.current = routes.current.length ? requestAnimationFrame(frame) : 0;
    };
    raf.current = requestAnimationFrame(frame);
  }, [map, ready, d.proposals, d.tasks, d.teams, d.sectors, d.mission]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [map],
  );
}

export const BEAT_ID = "live-heat-beat";
/** The beat's outline: in, held while the caption names it, out (ms). */
export const BEAT_IN_MS = 300;
export const BEAT_HOLD_MS = 1100;
export const BEAT_OUT_MS = 700;

/**
 * The guided time-lapse's beat on the map (story.ts `useLapseBeat`): the sectors it is about outlined and
 * the teams it names ringed, in for the beat and out after, so the map shows the one thing the caption
 * names; the camera pans gently to it only when it is off-screen. Reduced motion: no fades, no pan animation.
 */
export function useBeatLayer(map: Map | null, ready: boolean, d: { sectors: readonly SectorNow[]; teams: readonly Team[] }): void {
  const beat = useLapseBeat((s) => s.beat);
  const data = useRef(d);
  data.current = d;
  useEffect(() => {
    if (!map || !ready) return;
    if (!map.getSource(BEAT_ID)) map.addSource(BEAT_ID, { type: "geojson", data: fc([]) as never });
    const ink = cssVar("--text", "#f2f2f0");
    const before = map.getLayer("live-heat-halos") ? "live-heat-halos" : undefined;
    const t = { duration: prefersReducedMotion() ? 0 : BEAT_IN_MS, delay: 0 };
    const is = (k: string) => ["==", ["get", "kind"], k] as never;
    if (!map.getLayer(`${BEAT_ID}-glow`)) map.addLayer({ id: `${BEAT_ID}-glow`, type: "line", source: BEAT_ID, filter: is("sector"), paint: { "line-color": ink, "line-width": 8, "line-blur": 6, "line-opacity": 0, "line-opacity-transition": t } }, before);
    if (!map.getLayer(BEAT_ID)) map.addLayer({ id: BEAT_ID, type: "line", source: BEAT_ID, filter: is("sector"), paint: { "line-color": ink, "line-width": 2, "line-opacity": 0, "line-opacity-transition": t } }, before);
    if (!map.getLayer(`${BEAT_ID}-ring`)) map.addLayer({ id: `${BEAT_ID}-ring`, type: "circle", source: BEAT_ID, filter: is("team"), paint: { "circle-radius": 16, "circle-color": ink, "circle-opacity": 0, "circle-opacity-transition": t, "circle-stroke-color": ink, "circle-stroke-width": 2, "circle-stroke-opacity": 0, "circle-stroke-opacity-transition": t } }, before);
  }, [map, ready]);
  useEffect(() => {
    if (!map || !ready) return undefined;
    const reduced = prefersReducedMotion();
    const show = (on: boolean) => {
      try {
        const out = { duration: reduced ? 0 : on ? BEAT_IN_MS : BEAT_OUT_MS, delay: 0 };
        map.setPaintProperty(`${BEAT_ID}-glow`, "line-opacity-transition", out);
        map.setPaintProperty(`${BEAT_ID}-glow`, "line-opacity", on ? 0.45 : 0);
        map.setPaintProperty(BEAT_ID, "line-opacity-transition", out);
        map.setPaintProperty(BEAT_ID, "line-opacity", on ? 0.95 : 0);
        map.setPaintProperty(`${BEAT_ID}-ring`, "circle-opacity-transition", out);
        map.setPaintProperty(`${BEAT_ID}-ring`, "circle-opacity", on ? 0.12 : 0);
        map.setPaintProperty(`${BEAT_ID}-ring`, "circle-stroke-opacity-transition", out);
        map.setPaintProperty(`${BEAT_ID}-ring`, "circle-stroke-opacity", on ? 0.9 : 0);
      } catch {
        /* the map went away */
      }
    };
    const { sectors, teams } = data.current;
    const features: Feature[] = [];
    for (const id of beat?.sectors ?? []) {
      const poly = sectors.find((s) => s.sector_id === id)?.polygon;
      if (poly?.length) features.push({ type: "Feature", properties: { kind: "sector" }, geometry: { type: "LineString", coordinates: poly } });
    }
    for (const id of beat?.teams ?? []) {
      const p = teams.find((t) => t.id === id)?.position;
      if (p) features.push({ type: "Feature", properties: { kind: "team" }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } });
    }
    if (!features.length) {
      show(false);
      return undefined;
    }
    setData(map, BEAT_ID, features);
    show(true);
    // off-screen: one gentle pan to it (never a zoom, never for something already in view)
    const pts = features.flatMap((f) => (f.geometry.type === "Point" ? [f.geometry.coordinates as LonLat] : [centreOf(f.geometry.coordinates as LonLat[])]));
    const at: LonLat = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const c = map.getContainer();
    const p = map.project(at);
    const mx = c.clientWidth * 0.12;
    const my = c.clientHeight * 0.12;
    if (p.x < mx || p.y < my || p.x > c.clientWidth - mx || p.y > c.clientHeight - my) map.easeTo({ center: at, duration: reduced ? 0 : 1000 });
    const id = window.setTimeout(() => show(false), BEAT_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [map, ready, beat]);
}

function centreOf(poly: readonly (readonly [number, number])[]): LonLat {
  const ring = poly.slice(0, -1);
  const pts = ring.length ? ring : poly;
  return [pts.reduce((a, c) => a + c[0], 0) / pts.length, pts.reduce((a, c) => a + c[1], 0) / pts.length];
}

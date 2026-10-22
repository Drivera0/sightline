// The assignment card (LANE_E §7, E-09): one printable page per assigned sector, from lane B's card
// (`GET /missions/{id}/cards/{sector}`): where to enter, the sweep waypoints, what to look for (with
// the photo crops), POA and drone coverage, conditions, daylight, the radio. Print, GPX and KML
// buttons; `@media print` gives white paper, black text, no buttons. Built by lane A for lane E (#70).
import type { AssignmentCard } from "../contract";
import { Label } from "../shell/components";

const pct = (v: number) => `${Math.round(v * 100)} %`;
const latlon = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export const compass = (bearing: number) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

/** The sector outline (and the entry point) as SVG path data in a 100 × 100 box, north up. */
export function outline(card: Pick<AssignmentCard, "polygon" | "entry">): { path: string; entry: [number, number] } {
  // equirectangular around the sector: a degree of longitude is cos(lat) of a degree of latitude
  const k = Math.cos((card.entry.lat * Math.PI) / 180);
  const pts = card.polygon.map(([lon, lat]) => [lon * k, lat] as [number, number]);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const at = (lon: number, lat: number): [number, number] => [5 + (90 * (lon - x0)) / span, 95 - (90 * (lat - y0)) / span];
  const path = pts.map(([lon, lat], i) => `${i ? "L" : "M"}${at(lon, lat).map((v) => v.toFixed(1)).join(" ")}`).join(" ") + " Z";
  return { path, entry: at(card.entry.lon * k, card.entry.lat) };
}

export function AssignmentCardView({
  card,
  gpxUrl,
  kmlUrl,
  imageUrl,
  backHref,
}: {
  card: AssignmentCard;
  gpxUrl: string;
  kmlUrl: string;
  imageUrl: (rel: string) => string;
  backHref?: string;
}) {
  const { path, entry } = outline(card);
  const team = card.team_callsign ?? "Unassigned";
  const btn = "rounded-full border border-border px-4 py-1.5 text-small text-text";
  return (
    <article aria-label={`Assignment card ${card.sector_label}`} className="assignment-card mx-auto flex max-w-3xl flex-col gap-4 print:max-w-none print:gap-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {backHref && (
          <a className="text-small text-accent-soft underline" href={backHref}>
            ← Command view
          </a>
        )}
        <span className="ml-auto" />
        <button type="button" className={btn} onClick={() => window.print()}>
          Print
        </button>
        <a className={btn} href={gpxUrl} download={`${card.sector_id}.gpx`}>
          Download GPX
        </a>
        <a className={btn} href={kmlUrl} download={`${card.sector_id}.kml`}>
          Download KML
        </a>
      </div>

      <header className="flex items-start gap-4">
        <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0 text-accent-soft print:text-black" role="img" aria-label="Sector outline, north up">
          <path d={path} fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth={1.5} />
          <circle cx={entry[0]} cy={entry[1]} r={3.5} fill="currentColor" />
          <text x={50} y={8} textAnchor="middle" fontSize={8} fill="currentColor">
            N
          </text>
        </svg>
        <div className="flex flex-col gap-1">
          <h1 className="text-title text-text print:text-black">
            {team} · Sector {card.sector_label} ({card.sector_id})
          </h1>
          <p className="text-small text-text-2 print:text-black">
            POA {pct(card.poa)} · drone coverage {pct(card.drone_coverage)} · {(card.area_m2 / 10_000).toFixed(1)} ha
          </p>
          {card.conditions_line && <p className="text-small text-text-2 print:text-black">{card.conditions_line}</p>}
          {card.daylight_remaining_min !== null && (
            <p className="text-small text-text-2 print:text-black">
              {card.daylight_remaining_min > 0 ? `Daylight left: ${card.daylight_remaining_min} min` : "No daylight left"}
            </p>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-1">
        <Label>Entry point</Label>
        <p className="text-body text-text print:text-black">
          {card.entry.name}: {latlon(card.entry.lat, card.entry.lon)}
          {card.bearing_deg_from_team !== null && card.distance_m_from_team !== null && (
            <>
              {" "}
              · {card.distance_m_from_team} m at {card.bearing_deg_from_team}° ({compass(card.bearing_deg_from_team)}) from {team}&apos;s last position
            </>
          )}
        </p>
      </section>

      <section className="flex flex-col gap-1">
        <Label>Look for</Label>
        <ul className="list-disc pl-5 text-body text-text print:text-black">
          {card.look_for.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        {card.evidence_crops.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {card.evidence_crops.map((c) => (
              <img key={c} src={imageUrl(c)} alt={`photo crop ${c}`} className="h-24 w-24 rounded-sm border border-border object-cover print:h-16 print:w-16" />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <Label>Waypoints ({card.waypoints.length})</Label>
        <table className="text-small text-text print:text-[9pt] print:leading-tight print:text-black">
          <thead>
            <tr className="text-left text-text-3 print:text-black">
              <th className="pr-4 font-normal">Name</th>
              <th className="pr-4 font-normal">Lat, lon</th>
              <th className="font-normal">Note</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {card.waypoints.map((w, i) => (
              // by position: the entry can share a corner's name
              <tr key={i}>
                <td className="pr-4">{w.name}</td>
                <td className="pr-4">{latlon(w.lat, w.lon)}</td>
                <td>{w.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-1">
        <Label>Radio</Label>
        <p className="text-body text-text print:text-black">{card.radio}</p>
        <p className="text-small text-text-2 print:text-black">
          Sightline reads every clue back; confirm it before it is logged.
        </p>
      </section>
      <p className="text-caption text-text-3 print:text-black">
        Generated {card.generated_at.slice(0, 16).replace("T", " ")} UTC · mission {card.mission_id}
      </p>
    </article>
  );
}

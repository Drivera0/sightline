// Open play (#play): set up your own search, then the console opens on it. A checklist of six steps, the
// way a search manager sets a search up (who is missing, where they were last seen, base camp, ground
// teams, drones and how their photos come in, review), each ticking when it is done, beside a live map of
// the surveyed area. Everything runs in this browser on the console's own engine; what the engine cannot
// apply yet is said on the review, never left out. The model is command/openPlay.ts, the mission it makes
// command/openPlayMission.ts. Built by lane A.
import { lazy, Suspense, useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { AppBar } from "../shell/AppBar";
import { Button, DisclosureChip, Label } from "../shell/components";
import { Icon } from "../shell/icons";
import {
  AREA_WORDS,
  CALL_LOCAL,
  CHECK_INS,
  dronesProblem,
  EMPTY_SETUP,
  FEEDS,
  inArea,
  lastSeenProblem,
  loadSetup,
  MAX_DRONES,
  MAX_MEMBERS,
  MAX_TEAMS,
  metres,
  MIN_MEMBERS,
  MIN_TEAMS,
  nextCallsign,
  PLAY_CONSOLE_HASH,
  PROFILES,
  ready,
  saveSetup,
  sectorOf,
  snapToArea,
  STAGING,
  startSetup,
  steps,
  teamsProblem,
  type FeedKind,
  type LatLon,
  type PlaySetup,
  type StepId,
} from "../command/openPlay";
import { SWEEP_MS, TEAM_POD, WALK_MS } from "../command/sim";
import { REPO_URL } from "./judges";

const PlayMap = lazy(() => import("./PlayMap").then((m) => ({ default: m.PlayMap })));

const field = "w-full min-w-0 rounded-sm border border-border bg-surface-strong px-3 py-2 text-body text-text disabled:opacity-50";
const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** The step's mark: its number, or a tick once done. */
function StepMark({ n, done, active }: { n: number; done: boolean; active: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-small font-medium tabular-nums ${done ? "border-[var(--found)] bg-[var(--found)] text-on-accent" : active ? "border-accent text-text" : "border-border text-text-2"}`}
    >
      {done ? (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.5 8.4 3 3 6-6.6" />
        </svg>
      ) : (
        n
      )}
    </span>
  );
}

function Choice({ name, checked, onChange, disabled = false, children, tag }: { name: string; checked: boolean; onChange: () => void; disabled?: boolean; children: ReactNode; tag?: string }) {
  return (
    <label
      className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-sm border px-3 py-2.5 text-small ${checked ? "border-accent bg-surface-strong" : "border-border hover:border-text-3"} ${disabled ? "cursor-not-allowed opacity-70 hover:border-border" : ""}`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-1 shrink-0 accent-[var(--accent)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
      {tag && <span className="shrink-0 rounded-full border border-line px-2 py-px text-caption text-text-2">{tag}</span>}
    </label>
  );
}

function Next({ onClick, children = "Next step" }: { onClick: () => void; children?: ReactNode }) {
  return (
    <div className="flex justify-end pt-1">
      <Button onClick={onClick}>{children}</Button>
    </div>
  );
}

// ---- the steps --------------------------------------------------------------------------------------

function WhoStep({ s, set, next }: { s: PlaySetup; set: (p: Partial<PlaySetup>) => void; next: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-small text-text-2">Profile: how a person like this tends to travel, and the clues the field reports.</legend>
        {PROFILES.map((p) => (
          <Choice key={p.seed} name="profile" checked={s.profile === p.seed} onChange={() => set({ profile: p.seed, subject: s.profile === p.seed && s.subject ? s.subject : p.subject })}>
            <span className="font-medium text-text">{p.name}</span>
            <span className="text-text-2">{p.subject}</span>
          </Choice>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-small text-text-2">
        Description: age, clothing, anything the teams should look for
        <input className={field} value={s.subject} maxLength={160} onChange={(e) => set({ subject: e.target.value })} placeholder="adult, 34, orange shell jacket, grey pack" disabled={!s.profile} />
      </label>
      <p className="text-caption text-text-3">The AI compares every survey photo with this description: a person whose age or clothing does not match is flagged as someone else, a witness to ask.</p>
      {s.profile && <p className="text-caption text-text-3">Where the map starts: {PROFILES.find((p) => p.seed === s.profile)!.prior}.</p>}
      <Next onClick={next} />
    </div>
  );
}

function WhereStep({ s, set, note, next }: { s: PlaySetup; set: (p: Partial<PlaySetup>) => void; note: string | null; next: () => void }) {
  const [lat, setLat] = useState(s.lkp ? s.lkp.lat.toFixed(5) : "");
  const [lon, setLon] = useState(s.lkp ? s.lkp.lon.toFixed(5) : "");
  useEffect(() => {
    setLat(s.lkp ? s.lkp.lat.toFixed(5) : "");
    setLon(s.lkp ? s.lkp.lon.toFixed(5) : "");
  }, [s.lkp]);
  const typed = () => {
    const p = { lat: Number(lat), lon: Number(lon) };
    if (lat !== "" && lon !== "" && Number.isFinite(p.lat) && Number.isFinite(p.lon)) set({ lkp: snapToArea(p) });
  };
  const seen = lastSeenProblem(s.lastSeen);
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Search area" className="flex flex-col gap-2">
        <Choice name="area" checked onChange={() => undefined} tag="Surveyed">
          <span className="font-medium text-text">Mount Seymour, North Shore</span>
          <span className="text-text-2">{AREA_WORDS}, with the drone survey's aerial photos</span>
        </Choice>
        <Choice name="area" checked={false} onChange={() => undefined} disabled tag="Not yet">
          <span className="font-medium text-text">Another North Shore area</span>
          <span className="text-text-2">More areas need a survey flown there first: the detector reads that area's own photos.</span>
        </Choice>
      </div>
      <p className="text-small text-text">
        <span className="font-medium">Click the map</span> inside the orange outline where they were last seen. A point outside it moves to the nearest place inside.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-caption text-text-2">
          Latitude
          <input className={field} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} onBlur={typed} placeholder="49.3700" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-caption text-text-2">
          Longitude
          <input className={field} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} onBlur={typed} placeholder="-122.9450" />
        </label>
      </div>
      {note && (
        <p role="status" className="text-caption text-warn">
          {note}
        </p>
      )}
      {s.lkp && inArea(s.lkp) && <p className="text-caption text-text-2">Last known point in sector {sectorOf(s.lkp)}.</p>}
      <label className="flex max-w-[12rem] flex-col gap-1 text-small text-text-2">
        Last seen at (local time)
        <input className={field} type="time" value={s.lastSeen} onChange={(e) => set({ lastSeen: e.target.value })} max={CALL_LOCAL} />
      </label>
      <p className={`text-caption ${seen ? "text-warn" : "text-text-3"}`}>{seen ?? `The call comes in at ${CALL_LOCAL}; the subject strip says how long ago they were seen.`}</p>
      <Next onClick={next} />
    </div>
  );
}

function CampStep({ s, set, next }: { s: PlaySetup; set: (p: Partial<PlaySetup>) => void; next: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-2">Where teams stage and the drones launch and land: a place a vehicle can reach. Choose one here or click its dot on the map.</p>
      <div role="radiogroup" aria-label="Base camp" className="flex flex-col gap-2">
        {STAGING.map((x) => (
          <Choice key={x.name} name="camp" checked={s.camp === x.name} onChange={() => set({ camp: x.name })} tag={s.lkp ? `${km(metres(x, s.lkp))} to the last known point` : undefined}>
            <span className="font-medium text-text">{x.name}</span>
            <span className="text-text-2">{x.note}</span>
          </Choice>
        ))}
      </div>
      <Next onClick={next} />
    </div>
  );
}

function TeamsStep({ s, set, next }: { s: PlaySetup; set: (p: Partial<PlaySetup>) => void; next: () => void }) {
  const problem = teamsProblem(s.teams);
  const edit = (i: number, p: Partial<PlaySetup["teams"][number]>) => set({ teams: s.teams.map((t, k) => (k === i ? { ...t, ...p } : t)), confirmed: { ...s.confirmed, teams: true } });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-2">
        {MIN_TEAMS} to {MAX_TEAMS} ground teams. The callsign is what the radio, the log and the assignment cards say.
      </p>
      <ul className="flex flex-col gap-2" aria-label="Ground teams">
        {s.teams.map((t, i) => (
          <li key={i} className="flex min-w-0 items-end gap-2 rounded-sm border border-line px-2.5 py-2">
            <Icon name="team" size={18} className="mb-2.5 shrink-0 text-team" />
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption text-text-2">
              Callsign
              <input className={field} value={t.callsign} maxLength={24} onChange={(e) => edit(i, { callsign: e.target.value })} aria-label={`Team ${i + 1} callsign`} />
            </label>
            <label className="flex w-[4.5rem] shrink-0 flex-col gap-1 text-caption text-text-2">
              People
              <input
                className={field}
                type="number"
                min={MIN_MEMBERS}
                max={MAX_MEMBERS}
                value={t.members}
                onChange={(e) => edit(i, { members: Math.round(Number(e.target.value)) })}
                aria-label={`${t.callsign || `Team ${i + 1}`}: people`}
              />
            </label>
            <button
              type="button"
              onClick={() => set({ teams: s.teams.filter((_, k) => k !== i), confirmed: { ...s.confirmed, teams: true } })}
              disabled={s.teams.length <= MIN_TEAMS}
              aria-label={`Remove ${t.callsign || `team ${i + 1}`}`}
              title={s.teams.length <= MIN_TEAMS ? `A search needs at least ${MIN_TEAMS} teams` : "Remove this team"}
              className="sl-tap mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-text-2 hover:bg-surface-strong hover:text-text disabled:opacity-40"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => set({ teams: [...s.teams, { callsign: nextCallsign(s.teams), members: 3 }], confirmed: { ...s.confirmed, teams: true } })} disabled={s.teams.length >= MAX_TEAMS}>
          Add a team
        </Button>
        <label className="flex w-full items-center gap-2 whitespace-nowrap text-small text-text-2 sm:ml-auto sm:w-auto">
          Radio check-in every
          <select className={`${field} w-auto`} value={s.checkInMin} onChange={(e) => set({ checkInMin: Number(e.target.value), confirmed: { ...s.confirmed, teams: true } })}>
            {CHECK_INS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={`text-caption ${problem ? "text-warn" : "text-text-3"}`}>{problem ?? "A team not heard on the radio within the check-in interval shows as overdue on the console."}</p>
      <Next onClick={() => (set({ confirmed: { ...s.confirmed, teams: true } }), next())}>Confirm the teams</Next>
    </div>
  );
}

function DronesStep({ s, set, next }: { s: PlaySetup; set: (p: Partial<PlaySetup>) => void; next: () => void }) {
  const problem = dronesProblem(s.drones);
  const setCount = (n: number) => set({ drones: Array.from({ length: n }, (_, i) => s.drones[i] ?? (i === 0 ? "survey" : "survey")), confirmed: { ...s.confirmed, drones: true } });
  const setFeed = (i: number, f: FeedKind) => set({ drones: s.drones.map((x, k) => (k === i ? f : x)), confirmed: { ...s.confirmed, drones: true } });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-small text-text-2">Drones</span>
        <span role="group" aria-label="Number of drones" className="flex items-center gap-0.5 rounded-full border border-line p-0.5">
          {Array.from({ length: MAX_DRONES }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" aria-pressed={s.drones.length === n} onClick={() => setCount(n)} className={`sl-tap min-w-10 rounded-full px-3 py-1 text-small ${s.drones.length === n ? "bg-surface-strong font-medium text-text" : "text-text-2 hover:text-text"}`}>
              {n}
            </button>
          ))}
        </span>
      </div>
      {s.drones.map((f, i) => (
        <fieldset key={i} className="flex min-w-0 flex-col gap-2 rounded-sm border border-line p-2.5">
          <legend className="flex items-center gap-1.5 px-1 text-small font-medium text-text">
            <Icon name="drone" size={16} className="text-drone" /> Drone {i + 1}: how its photos come in
          </legend>
          {FEEDS.map((x) => (
            <Choice key={x.id} name={`feed-${i}`} checked={f === x.id} onChange={() => setFeed(i, x.id)} disabled={!x.here} tag={x.here ? undefined : x.id === "video" ? "Not supported" : "Field kit"}>
              <span className="font-medium text-text">{x.label}</span>
              {(f === x.id || !x.here) && <span className="text-text-2">{x.what}</span>}
            </Choice>
          ))}
        </fieldset>
      ))}
      <details className="rounded-sm border border-line px-3 py-2 text-small">
        <summary className="sl-tap cursor-pointer text-text">Connecting a real drone's photos: what the field kit runs</summary>
        <div className="flex flex-col gap-2 pt-2 text-text-2">
          <p>On the command-post laptop, start the mission server, open the console with it (VITE_API_URL set), start a search at #new, then watch the SD card's folder (or the controller's download folder, for photos during the flight):</p>
          <pre className="overflow-x-auto rounded-sm bg-surface-strong p-2 font-mono text-caption text-text">{FEEDS.find((x) => x.id === "folder")!.run}</pre>
          <p>
            The full steps are in the repository's README, under Mission API.{" "}
            <a className="text-text underline underline-offset-2" href={`${REPO_URL}#mission-api`} target="_blank" rel="noreferrer">
              Open the README
            </a>
          </p>
        </div>
      </details>
      <p className={`text-caption ${problem ? "text-warn" : "text-text-3"}`}>{problem ?? "Each drone flies from base camp; the console shows its battery, its link and the photos as they land."}</p>
      <Next onClick={() => (set({ confirmed: { ...s.confirmed, drones: true } }), next())}>Confirm the drones</Next>
    </div>
  );
}

/** The review: every setting, what it does on the console, and what stays fixed in this build. */
export function Review({ s, onStart }: { s: PlaySetup; onStart: () => void }) {
  const profile = PROFILES.find((p) => p.seed === s.profile);
  const camp = STAGING.find((x) => x.name === s.camp);
  const uploads = s.drones.map((f, i) => (f === "upload" ? i + 1 : 0)).filter(Boolean);
  const ok = ready(s);
  const rows: [string, ReactNode, string][] = [
    ["Who", profile ? `${profile.name}: ${s.subject.trim()}` : "not set", "The AI compares each survey photo with the description."],
    ["Last known point", s.lkp ? `${s.lkp.lat.toFixed(5)}, ${s.lkp.lon.toFixed(5)} · sector ${sectorOf(s.lkp) ?? "outside"}` : "not set", profile && !profile.rings ? "Marked on the map and the subject strip. This profile's probability map is even over the area (no checked source yet), so the AI ranks the sectors from the clues and the photos, not from this point." : "The profile's probability map (its distance rings) is moved here; the AI ranks the sectors from it."],
    ["Last seen", s.lastSeen, "On the subject strip, with how long ago."],
    ["Base camp", camp?.name ?? "not set", "Teams wait here at the call; the drones launch and land here."],
    ["Ground teams", `${s.teams.map((t) => `${t.callsign.trim()} (${t.members})`).join(", ")} · check-in every ${s.checkInMin} min`, "These names on the radio, the log and the cards; a team past its check-in shows as overdue."],
    ["Drones", s.drones.map((f, i) => `Drone ${i + 1}: ${FEEDS.find((x) => x.id === f)!.label.toLowerCase()}`).join(" · "), "Only these drones fly."],
  ];
  const fixed = [
    `Where the person really is comes from the ${profile?.name.toLowerCase() ?? "profile's"} scenario and does not move with your last known point: put the point far from it and the search takes longer.`,
    `The clues the field radios in are that scenario's.`,
    `A team walks to its sector in ${WALK_MS / 60_000} minutes and sweeps it in ${SWEEP_MS / 60_000}, from any base camp; its head count does not change its chance of finding the person on one pass (${Math.round(TEAM_POD * 100)} %).`,
    "The survey lands the same set of photos however many drones fly; fewer drones share it fewer ways.",
    ...(uploads.length ? [`Drone ${uploads.join(" and ")} brings in only the photos you drop: open Photos and drop the card's photos, or load the 20 sample photos.`] : []),
    ...(s.teams.length < 4 ? ["The scenario's teams past your roster are left out, with the proposals they had."] : []),
    "The probability map does not grow with the hours since they were last seen.",
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-[var(--line)] rounded-sm border border-line">
        {rows.map(([k, v, what]) => (
          <div key={k} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[8.5rem_1fr]">
            <dt className="text-caption text-text-3">{k}</dt>
            <dd className="min-w-0 break-words text-small text-text">
              {v}
              <span className="block text-caption text-text-2">{what}</span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-small font-medium text-text">What stays fixed in this build</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-caption text-text-2">
          {fixed.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onStart} disabled={!ok}>
          Start the search
        </Button>
        <span className="text-caption text-text-2">{ok ? "The console opens paused at the call: assign teams, add a clue or try a photo, then press Play." : "Finish the steps above to start."}</span>
      </div>
    </div>
  );
}

// ---- the page --------------------------------------------------------------------------------------

export function OpenPlay() {
  const [s, setS] = useState<PlaySetup>(() => loadSetup() ?? EMPTY_SETUP);
  const list = steps(s);
  const [open, setOpen] = useState<StepId>(() => list.find((x) => !x.done)?.id ?? "review");
  const [note, setNote] = useState<string | null>(null);
  const base = useId();
  const set = useCallback((p: Partial<PlaySetup>) => setS((x) => ({ ...x, ...p })), []);
  useEffect(() => saveSetup(s), [s]);
  const onLkp = useCallback((p: LatLon) => {
    const at = snapToArea(p);
    setNote(inArea(p) ? null : "That point is outside the surveyed area: it moved to the nearest place inside the outline.");
    setS((x) => ({ ...x, lkp: at }));
    setOpen((o) => (o === "who" || o === "camp" ? "where" : o));
  }, []);
  const onCamp = useCallback((name: string) => {
    setS((x) => ({ ...x, camp: name }));
    setOpen((o) => (o === "who" || o === "where" ? "camp" : o));
  }, []);
  const order: StepId[] = ["who", "where", "camp", "teams", "drones", "review"];
  const next = (from: StepId) => () => {
    const after = order.slice(order.indexOf(from) + 1);
    const now = steps(s);
    setOpen(after.find((id) => !now.find((x) => x.id === id)!.done) ?? "review");
  };
  const done = list.filter((x) => x.required && x.done).length;
  const required = list.filter((x) => x.required).length;
  const start = () => {
    if (!ready(s)) return;
    startSetup(s);
    window.location.hash = PLAY_CONSOLE_HASH;
  };
  const body = (id: StepId) => {
    if (id === "who") return <WhoStep s={s} set={set} next={next("who")} />;
    if (id === "where") return <WhereStep s={s} set={set} note={note} next={next("where")} />;
    if (id === "camp") return <CampStep s={s} set={set} next={next("camp")} />;
    if (id === "teams") return <TeamsStep s={s} set={set} next={next("teams")} />;
    if (id === "drones") return <DronesStep s={s} set={set} next={next("drones")} />;
    return <Review s={s} onStart={start} />;
  };

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <AppBar action={{ label: "Guided simulation", href: "#scenarios" }} />
      <main className="flex min-h-0 flex-1 flex-col lg:grid lg:h-[calc(100dvh-48px)] lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <section aria-labelledby="play-title" className="relative order-2 flex min-w-0 flex-col gap-5 px-4 py-6 lg:order-1 lg:overflow-y-auto lg:px-8 lg:py-8">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label>Open play</Label>
              <DisclosureChip />
            </div>
            <h1 id="play-title" className="text-[30px] font-semibold leading-[36px] tracking-[-0.02em] text-text">
              Set up your own search
            </h1>
            <p className="text-body text-text-2">
              Six steps, in the order a search manager works: who is missing, where they were last seen, base camp, the ground teams and the drones. Then the console opens on your search, paused at the call, and every decision is yours.
            </p>
            <div className="flex items-center gap-3 pt-1" aria-live="polite">
              <span className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-surface-strong" aria-hidden>
                <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--found)] transition-[width] duration-200" style={{ width: `${(done / required) * 100}%` }} />
              </span>
              <span className="shrink-0 text-small text-text-2 tabular-nums">
                {done} of {required} done
              </span>
            </div>
          </header>

          <ol className="flex flex-col gap-2" aria-label="Setup checklist">
            {list.map((x) => {
              const isOpen = open === x.id;
              const panel = `${base}-${x.id}`;
              return (
                <li key={x.id} data-step={x.id} data-done={x.done ? "true" : "false"} className={`rounded-lg border bg-surface-solid ${isOpen ? "border-border" : "border-line"}`}>
                  <h2>
                    <button type="button" aria-expanded={isOpen} aria-controls={panel} onClick={() => setOpen(x.id)} className="sl-tap flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left">
                      <StepMark n={x.n} done={x.done} active={isOpen} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-body font-medium text-text">{x.title}</span>
                        <span className={`truncate text-caption ${x.done ? "text-text-2" : "text-text-3"}`}>
                          <span className="sr-only">{x.done ? "Done: " : x.required ? "To do: " : ""}</span>
                          {x.status}
                        </span>
                      </span>
                      <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" className={`shrink-0 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m4 6 4 4 4-4" />
                      </svg>
                    </button>
                  </h2>
                  {isOpen && (
                    <div id={panel} className="border-t border-line px-3.5 pb-4 pt-3">
                      {body(x.id)}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            {open !== "review" && (
              <Button variant="primary" onClick={() => setOpen(ready(s) ? "review" : list.find((x) => x.required && !x.done)!.id)}>
                {ready(s) ? "Review and start" : "Go to the next step to do"}
              </Button>
            )}
            <button
              type="button"
              onClick={() => {
                setS(EMPTY_SETUP);
                setNote(null);
                setOpen("who");
              }}
              className="sl-tap text-small text-text-2 underline underline-offset-2 hover:text-text"
            >
              Start over
            </button>
          </div>
        </section>

        <aside aria-label="Map preview" className="relative order-1 h-[44vh] min-h-[280px] border-b border-line lg:order-2 lg:h-auto lg:border-b-0 lg:border-l">
          <Suspense fallback={<div className="h-full w-full bg-surface-solid" />}>
            <PlayMap lkp={s.lkp} camp={s.camp} onLkp={onLkp} onCamp={onCamp} className="h-full w-full" />
          </Suspense>
          <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-x-3 gap-y-1 rounded-sm border border-line bg-surface-solid px-2.5 py-1.5 text-caption text-text-2 shadow-[var(--shadow-pop)]">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-3.5 rounded-[2px] border-2 border-accent" /> Search area
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-full bg-accent" /> Last known point
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-full bg-[var(--team)]" /> Staging points
            </span>
          </div>
        </aside>
      </main>
    </div>
  );
}

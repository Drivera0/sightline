// The guided search on the console (`#m/demo?guide=1`): the clock that runs to each decision and waits
// there, the mark that asks for it, what each option does on the console, "Watch instead", and the end
// screen. guide.ts says what the decisions are, sim.ts what follows from them, missionTime.ts what the
// console shows. LiveMission mounts it with the story wiring. Built by lane A.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CacheBundle, MissionEvent, Proposal } from "../contract";
import { operatorName, useMission } from "../lib/mission";
import { prefersReducedMotion } from "../metrics/motion";
import type { LiveAnswer, ReviewCard } from "../review/LiveReview";
import { GuideMark, type GuideOption } from "./CoachMark";
import { useConsole } from "./consoleStore";
import { compare } from "./compare";
import { GuideEnd } from "./GuideEnd";
import { candidatePosition, demoCards, landedFrames } from "./demoReview";
import {
  activeInject,
  agentOption,
  choiceFor,
  choiceFromConsole,
  costsOf,
  currentCard,
  hotWash,
  injectDone,
  injects,
  lastLight,
  PIPS,
  standingUser,
  TRIAGE_OPTIONS,
  triageEffect,
  type GuideInput,
  type Inject,
  type TriageAnswer,
} from "./guide";
import { demoAt, onMissionClock, subjectOf, type DemoFull, type GuidedOpts } from "./missionTime";
import { GuideStrip } from "./Scrubber";
import { fixtureOf, passesFrom, realOf, type Cost } from "./sim";
import { dwellFor, lapseStep, SPEEDS, useGuide, useStory, type Lapse, type Speed } from "./story";
import { buildTimeline } from "./timeline";
import { STORY_NOT_A_PERSON, storyClue } from "./storyCopy";
import { clock as clockText, DEMO_TZ } from "../lib/time";

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
type Decide = (pid: string, decision: "approve" | "reject", by: string, reason?: string, edits?: Record<string, string>) => Promise<void>;

export interface GuideRun {
  on: boolean;
  /** The fixtures' clock (what demoAt reads) and the mission clock (what the console prints). */
  fixtureClock: string | null;
  missionClock: string | null;
  opts: GuidedOpts | null;
  costs: Cost[];
  /** Needs you shows the current decision only. */
  proposals: (all: readonly Proposal[]) => Proposal[];
  cards: (all: readonly ReviewCard[]) => ReviewCard[];
  /** The proposal the current decision is about (its card glows). */
  proposal: string | null;
  /** Needs you: the kinds of item the current step is about (NeedsYou `step`), or null with no guide. */
  needsHighlight: string | null;
  /** An approval of an assignment sends the team (the fixtures' manager no longer does). */
  decide: Decide;
  strip: ReactNode;
  overlay: ReactNode;
}

/** What the guided search changes in the fixtures (missionTime.ts): the seed, the read-back clue and whether it is mapped. */
export function guidedOptsFor(scenario: DemoFull | null, seed: string, choices: readonly { inject: string; option: string }[], user: readonly MissionEvent[]): GuidedOpts {
  const clue = storyClue(scenario);
  const readback = clue?.source === "radio" ? clue.id : null;
  const chosen = choices.find((c) => c.inject === "clue");
  const confirmed = user.some((e) => e.type === "clue.added" && e.ref === readback && !/logged/.test(e.summary));
  return { seed, readback, mapClue: chosen ? chosen.option !== "log" : confirmed };
}

export function useGuideRun({
  demo,
  scenario,
  seed,
  scenarioName,
  cache,
  answer,
  onPickOnMap,
  onReport,
  onTrace,
  onLeave,
  onRestart,
}: {
  demo: boolean;
  scenario: DemoFull | null;
  seed: string;
  scenarioName: string;
  cache: CacheBundle | null;
  answer: (id: string, a: LiveAnswer) => void;
  onPickOnMap: () => void;
  onReport: () => void;
  onTrace: () => void;
  onLeave: () => void;
  /** Start over on this seed (watch: the agent's line). */
  onRestart: (watch: boolean) => void;
}): GuideRun {
  const guide = useGuide((x) => x.guide);
  const on = demo && !!guide;
  const rawUser = useStory((x) => x.user);
  const answers = useStory((x) => x.answers);
  const choices = useMemo(() => guide?.choices ?? [], [guide?.choices]);
  // the standing approval's assignments are part of what the visitor did
  const user = useMemo(() => (on ? standingUser(scenario, seed, rawUser, choices) : rawUser), [on, scenario, seed, rawUser, choices]);
  const costs = useMemo(() => costsOf(choices), [choices]);
  const queue = useMemo(() => (cache ? demoCards(cache, landedFrames(cache, cache.survey.frames.length), (r) => r, true).map((c) => ({ id: c.id, conf: c.conf })) : []), [cache]);
  const input: GuideInput = useMemo(() => ({ full: scenario, seed, user, choices, queue }), [scenario, seed, user, choices, queue]);
  const list = useMemo(() => (on ? injects(input) : []), [on, input]);
  const active = on ? activeInject(list, choices) : null;
  const card = currentCard(active, choices);
  const clockMs = guide?.clock ?? 0;
  const f = fixtureOf(clockMs, costs);
  const light = realOf(lastLight(scenario), costs);
  const activeAt = active ? realOf(active.at, costs) : null;
  // nothing runs until the scenario is in; with no decision ahead (a pass under way) the clock runs to last light, never jumps there
  const hold = on && scenario && !guide!.ended ? Math.min(activeAt ?? light, light) : null;
  const reached = on && activeAt !== null && clockMs >= activeAt && activeAt <= light;
  const [status, setStatus] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // The time-lapse to the next decision (story.ts lapseStep): where this run started, and the timeline rows
  // that land on the way, read from the mission as it will stand at the hold (the same fixtures and engine
  // the console shows), so the clock can stop on each as it lands.
  const [run, setRun] = useState<{ hold: number; from: number } | null>(null);
  useEffect(() => {
    if (hold !== null) setRun((x) => (x && x.hold === hold ? x : { hold, from: useGuide.getState().guide?.clock ?? hold }));
  }, [hold]);
  const runFrom = run && run.hold === hold ? run.from : clockMs;
  const rows = useMemo(() => {
    if (!on || !scenario || hold === null || hold <= runFrom) return [];
    const at = onMissionClock(demoAt(scenario, iso(fixtureOf(hold, costs)), user, guidedOptsFor(scenario, seed, choices, rawUser), { seed }), costs);
    return buildTimeline(at.events ?? [], at.teams ?? [], at.timeline ?? [])
      .map((e) => ({ at: new Date(e.at).getTime(), text: e.text }))
      .filter((e) => e.at > runFrom && e.at <= hold)
      .sort((a, b) => a.at - b.at);
  }, [on, scenario, hold, runFrom, costs, user, seed, choices, rawUser]);
  const lapse: Lapse | null = hold === null ? null : { from: runFrom, hold, beats: [...new Set(rows.map((r) => r.at))] };
  const lapseRef = useRef(lapse);
  lapseRef.current = lapse;
  const dwellUntil = useRef(0);

  // the clock: ten readings a second toward the next decision, a moment on each row as it lands, and it stops there
  const running = on && !guide!.ended && !guide!.paused && hold !== null && clockMs < hold;
  useEffect(() => {
    if (!running) return undefined;
    // the real time since the last reading (a busy frame must not slow the mission down), at most a quarter second
    let last = performance.now();
    const id = window.setInterval(() => {
      const g = useGuide.getState().guide;
      const l = lapseRef.current;
      const now = performance.now();
      const dt = Math.min(250, now - last);
      last = now;
      if (!g || !l || g.paused || now < dwellUntil.current) return;
      const r = lapseStep(g.clock, l, dt, g.speed, prefersReducedMotion());
      if (r.beat) dwellUntil.current = now + dwellFor(l) / g.speed;
      useGuide.getState().setClock(r.clock);
    }, 100);
    return () => window.clearInterval(id);
  }, [running]);
  /** Skip ahead: straight to the next decision, every row on the way landing at once. */
  const skip = useCallback(() => {
    dwellUntil.current = 0;
    const l = lapseRef.current;
    if (l) useGuide.getState().setClock(l.hold);
  }, []);

  // last light with no find: the search suspends (no fail state)
  useEffect(() => {
    if (on && scenario && !guide!.ended && clockMs >= light && !reached) useGuide.getState().end();
  }, [on, guide?.ended, clockMs, light, reached]);

  // a decision made on the console itself counts
  useEffect(() => {
    if (!on || !active || !reached) return;
    const c = choiceFromConsole(active, input, answers, f);
    if (c) {
      useGuide.getState().choose(c);
      // what follows from it, as when it is made by key or by Watch instead
      if (active.id === "triage" && c.card) {
        const tc = active.cards?.find((x) => x.id === c.card);
        if (tc) follow(tc, c.option as TriageAnswer);
      } else if (active.id === "find" && active.find) carryOut(active.find.team, active.find.sector);
      setHint(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, active, reached, input, answers, f]);

  // the decision on screen, stamped once, for the end screen's decision time (compare.ts)
  const shownKey = reached && active ? (active.id === "triage" && card ? `triage:${card.id}` : active.key) : null;
  useEffect(() => {
    if (shownKey) useGuide.getState().show(shownKey);
  }, [shownKey]);

  // phones: the decision's panel in front
  useEffect(() => {
    if (reached && (active?.id === "triage" || active?.id === "assign" || active?.id === "clue" || active?.id === "wind")) useConsole.getState().setTab("needs");
  }, [reached, active?.id]);

  const decide: Decide = useCallback(async (pid, decision, by, reason, edits) => {
    const m = useMission.getState();
    const p = m.proposals.find((x) => x.id === pid);
    await m.decide(pid, decision, by, reason, edits);
    if (decision === "approve" && p?.kind === "assign_sector" && p.target.sector) {
      const team = edits?.team ?? p.target.team;
      if (team) await useMission.getState().assign(team, p.target.sector);
    }
  }, []);

  /** A team free for a side job (not `not`). */
  function free(not?: string) {
    const teams = useMission.getState().teams;
    return teams.find((t) => t.id !== not && (t.status === "standby" || t.status === "assigned")) ?? teams.find((t) => t.id !== not);
  }
  /** What a triage answer leads to beyond the review itself: a witness lead, or a team sent to check the bag. */
  function follow(c: { id: string }, a: TriageAnswer) {
    const m = useMission.getState();
    if (a === "not_subject" && c.id !== STORY_NOT_A_PERSON) {
      const at = candidatePosition(cache, c.id);
      if (at) {
        const text = `witness: another person on the ground in photo ${at.frame}, ask what they saw`;
        m.emit("clue.added", `other: ${text}`, `w-${c.id}`, { kind: "other", text, lat: at.lat, lon: at.lon, at_team_position: false, radius_m: 30, reliability: "low", reported_by: "command", source: "form", confirmed_by_turn: null, id: `w-${c.id}`, at: iso(f), confirmed: true });
      }
    }
    if (a === "person" && c.id === STORY_NOT_A_PERSON) {
      const t = free();
      if (t) void m.call(t.id, `check the pin from photo ${c.id.slice(0, 5)}, over.`);
    }
  }
  /** The find recorded: the nearest other team goes to carry out. */
  function carryOut(team: string, sector: string) {
    const carry = free(team);
    if (carry) void useMission.getState().call(carry.id, `carry-out to ${sector}, over.`);
  }

  /** One option of the current decision, done on the console as the manager would. */
  const perform = useCallback(
    (i: Inject, optionId: string, watched = false) => {
      const m = useMission.getState();
      const c = currentCard(i, useGuide.getState().guide?.choices ?? []);
      if (i.id === "assign" && optionId === "map") {
        setHint("Click a sector on the map, then pick a team in its popover.");
        onPickOnMap();
        return;
      }
      useGuide.getState().choose(choiceFor(i, optionId, f, c, watched));
      const by = operatorName();
      const teams = m.teams;
      if (i.id === "triage" && c) {
        const a = optionId as TriageAnswer;
        answer(c.id, a);
        follow(c, a);
      } else if (i.id === "clue") {
        const clue = storyClue(scenario);
        if (!clue) return;
        const team = teams.find((t) => t.id === clue.reported_by);
        if (optionId === "bearing") {
          if (team) void m.call(team.id, "say again your bearing to it, over.");
          m.emit("clue.added", `${clue.id} confirmed with a bearing`, clue.id, { ...clue, confirmed: true, reliability: "medium" });
        } else if (optionId === "log") {
          m.emit("clue.added", `${clue.id} logged without mapping`, clue.id, { ...clue, confirmed: true });
        } else {
          if (team) void m.call(team.id, `read back: ${clue.text}. Confirm, over.`);
          m.emit("clue.added", `${clue.id} confirmed`, clue.id, { ...clue, confirmed: true });
        }
      } else if ((i.id === "assign" || i.id === "wind") && i.proposal) {
        const team = optionId.startsWith("team:") ? optionId.slice(5) : undefined;
        void decide(i.proposal, "approve", by, undefined, team ? { team } : undefined);
      } else if (i.id === "link" && optionId === "relay") {
        m.emit("mission.note", `Relay: a second drone holds over the ridge for the one that lost its link; its own flight line stops (by ${by})`, null, { action: "relay", by });
      } else if (i.id === "find" && i.find) {
        const { team, sector } = i.find;
        if (optionId === "confirm") void m.call(team, "confirm the subject's description, over.");
        void m.found(team, sector);
        carryOut(team, sector);
      }
      setHint(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f, answer, cache, scenario, decide, onPickOnMap],
  );

  // watch instead: the reason for three seconds, then the agent's choice, through the same engine
  useEffect(() => {
    setStatus(null);
    if (!on || !guide!.watch || !active || !reached || guide!.ended) return undefined;
    const ag = agentOption(active, card);
    const t1 = window.setTimeout(() => setStatus(`Agent's choice: ${ag.label}`), 3000);
    const t2 = window.setTimeout(() => {
      setStatus(null);
      perform(active, ag.id, true);
    }, 4200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, guide?.watch, guide?.ended, active?.key, card?.id, reached]);

  // the find marked: a moment on the console, then what you did
  const findDone = choices.some((c) => c.inject === "find");
  useEffect(() => {
    if (!on || !findDone || guide!.ended) return undefined;
    const t = window.setTimeout(() => useGuide.getState().end(), 2500);
    return () => window.clearTimeout(t);
  }, [on, findDone, guide?.ended]);

  // ---- what is on screen ----
  const subject = subjectOf(scenario);
  const callsign = (id: string | null) => scenario?.data.teams?.find((t) => t.id === id)?.callsign ?? id ?? "";
  const ids: string[] = [];
  for (const i of list) {
    const future = (i.id === "find" || i.key.startsWith("assign-")) && !injectDone(i, choices) && !(reached && active?.key === i.key);
    if (!future && !ids.includes(i.id)) ids.push(i.id);
  }
  if (subject && !ids.includes("find")) ids.push("find");
  const pips = ids.map((id) => {
    const all = list.filter((i) => i.id === id);
    const done = all.length > 0 && all.every((i) => injectDone(i, choices)) && !(active?.id === id);
    const current = reached && active?.id === id;
    const count = id === "assign" ? all.filter((i) => injectDone(i, choices) || (reached && active?.key === i.key)).length : undefined;
    return { id, label: PIPS.find((p) => p.id === id)?.label ?? id, state: (done ? "done" : current ? "current" : "next") as "done" | "current" | "next", count };
  });
  // the step: the decision waiting, or (between decisions) the one the clock runs to
  const next = active ?? null;
  const n = Math.max(1, ids.indexOf(next?.id ?? "") + 1);
  const pip = PIPS.find((p) => p.id === next?.id)?.label ?? "";
  const triage = active?.id === "triage" && card ? active.cards!.indexOf(card) + 1 : 0;
  const step = `Step ${n} of ${ids.length} · ${pip}${triage ? `, photo ${triage} of ${active!.cards!.length}` : ""}`;
  const heading = reached ? step : next && pip ? `Next: ${step}` : "The teams search";

  // between decisions: the last cost being spent, or what leads to the next decision
  const lastCost = [...choices].reverse().find((c) => c.costMs > 0);
  const inCost = lastCost ? clockMs >= realOf(lastCost.f, costs) && clockMs < realOf(lastCost.f, costs) + lastCost.costMs : false;
  const progress = hold !== null && hold > runFrom ? (clockMs - runFrom) / (hold - runFrom) : 0;
  // the pass under way, in words (never where the subject is)
  const out = passesFrom(seed, subject, user).find((p) => !p.cut && p.start <= f && p.end > f);
  const walking = out ? `${callsign(out.team)} ${f < out.arrive ? `walks to ${out.sector}` : `sweeps ${out.sector} at POD ${out.pod.toFixed(2)} a pass`}.` : null;
  const lead = inCost && lastCost ? `${lastCost.label}: ${lastCost.costMs / 60_000} min on the clock.` : (walking ?? active?.lead ?? "The teams search; the clock runs until the radio has news.");
  // the time-lapse's caption: the row that landed last on this run, with its time (cause, then effect)
  // (a row more than ten mission minutes old gives way to what is under way now)
  const landed = [...rows].reverse().find((r) => r.at <= clockMs && clockMs - r.at <= 10 * 60_000);
  const caption = landed ?`${clockText(iso(landed.at), DEMO_TZ)} · ${landed.text}` : lead;

  // triage: the card's own answers (no buttons on the bar), so A gives the agent's reference answer; Object
  // (O) is left to the card, which asks for the object's type
  const options: GuideOption[] = !reached || !active ? [] : active.id === "triage" ? (card ? TRIAGE_OPTIONS.filter((o) => o.id !== "object").map((o) => ({ key: o.key, id: o.id, label: o.label, effect: triageEffect(card, o.id).effect, costMin: triageEffect(card, o.id).costMin, agent: o.id === card.line, on: "the photo's card in Needs you" })) : []) : active.options.map((o) => ({ ...o }));
  // triage is answered on the photo's card; what each answer does stays one click away
  const answerList =
    reached && active?.id === "triage" && card
      ? TRIAGE_OPTIONS.map((o) => {
          const e = triageEffect(card, o.id);
          return { key: o.key, label: o.label, effect: e.effect, costMin: e.costMin };
        })
      : undefined;
  const text = reached && active ? active.prompt : lead;
  const announce = reached && active ? `Your call, ${pip}: ${active.prompt}` : `Watch this: ${caption}`;
  const wash = useMemo(() => (on && guide!.ended ? hotWash(input, list) : null), [on, guide?.ended, input, list]);
  const versus = useMemo(() => (wash ? compare(input, wash, lastLight(scenario)) : null), [wash, input, scenario]);
  // Needs you (its `highlight`): the item this step is about ringed, the rest dimmed and out of reach; "none" between decisions
  const readback = storyClue(scenario);
  const needsHighlight = !reached || !active ? "none" : active.id === "triage" ? "review" : active.id === "clue" && readback ? `clue-${readback.id}` : (active.id === "assign" || active.id === "wind") && active.proposal ? active.proposal : active.id === "find" && active.find ? `report-${active.find.team}` : "none";

  const overlay = !on ? null : guide!.ended && wash ? (
    <GuideEnd
      wash={wash}
      versus={versus}
      sectors={scenario?.data.sectors ?? []}
      subject={subject}
      scenario={scenarioName}
      seed={seed}
      callsign={callsign}
      onReplay={() => onRestart(false)}
      onWatchAgent={() => onRestart(true)}
      onReport={onReport}
      onTrace={onTrace}
      onClose={() => useGuide.getState().stop()}
    />
  ) : (
    <GuideMark
      mode={reached ? "call" : "watch"}
      heading={heading}
      text={text}
      target={reached && active ? (card ? [`[data-candidate="${card.id}"]`, ...[active.target].flat()] : active.target) : []}
      why={reached ? (card ? card.says : active?.agentSays) : undefined}
      options={options}
      answers={answerList}
      onPick={(id) => active && perform(active, id)}
      onMap={active?.options.some((o) => o.id === "map") ? () => active && perform(active, "map") : undefined}
      status={status ?? hint ?? undefined}
      watching={!!guide!.watch}
      onWatch={() => useGuide.getState().setWatch(true)}
      onTakeOver={() => useGuide.getState().setWatch(false)}
      paused={!!guide!.paused}
      onPause={() => useGuide.getState().pause()}
      onExit={onLeave}
      clock={clockText(iso(clockMs), DEMO_TZ)}
      caption={caption}
      progress={reached ? undefined : progress}
      speed={guide!.speed}
      speeds={SPEEDS}
      onSpeed={(x) => useGuide.getState().setSpeed(x as Speed)}
      onSkip={hold !== null && !reached ? skip : undefined}
    />
  );

  return {
    on,
    fixtureClock: on ? iso(f) : null,
    missionClock: on ? iso(clockMs) : null,
    opts: on ? guidedOptsFor(scenario, seed, choices, user) : null,
    costs,
    proposals: (all) => (on ? all.filter((p) => p.status !== "pending" || (reached && p.id === active?.proposal)) : [...all]),
    cards: (all) => (on ? (reached && card ? all.filter((c) => c.id === card.id) : []) : [...all]),
    proposal: on && reached ? (active?.proposal ?? null) : null,
    needsHighlight: on && !guide!.ended ? needsHighlight : null,
    decide,
    strip: on && !guide!.ended ? <GuideStrip pips={pips} at={iso(clockMs)} call={reached} paused={!!guide!.paused} announce={announce} /> : null,
    overlay,
  };
}

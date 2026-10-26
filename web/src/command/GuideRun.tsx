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
  dronesWait,
  hotWash,
  injectDone,
  injects,
  lastLight,
  photoTitle,
  searchEnd,
  PIPS,
  standingUser,
  TRIAGE_OPTIONS,
  triageEffect,
  type Choice,
  type GuideInput,
  type Inject,
  type TriageAnswer,
} from "./guide";
import { CHECKPOINTS, demoAt, onMissionClock, subjectOf, type DemoFull, type GuidedOpts } from "./missionTime";
import { GuideStrip } from "./Scrubber";
import { fixtureOf, passesFrom, realOf, type Cost } from "./sim";
import { dwellAt, FREE_MAX_BEATS, FREE_MIN_PER_S, FREE_WINDOW_MS, LAPSE, lapseBeats, lapseStep, SPEEDS, useGuide, useLapseBeat, useStory, type Lapse, type Speed } from "./story";
import { beatCaption } from "./caption";
import { FreeClock } from "./FreeClock";
import { useNeedsTotal } from "./NeedsYou";
import { buildTimeline } from "./timeline";
import { storyClue } from "./storyCopy";
import { isLogged, isSightingProposal, overdueTeams, teamOrder, WATCH_BY } from "./console";
import { keepBest, missionGoals, missionScore, type Goal, type Score } from "./goals";
import { GoalsStrip } from "./GoalsStrip";
import { Tour } from "./Tour";
import { clock as clockText, DEMO_TZ } from "../lib/time";
import { podLabel } from "./terms";

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
  /** The assign step's main button on its card ("Send all N free teams…"); the card's own Approve becomes `second`. */
  lead: { id: string; label: string; onClick: () => void; second: string | null } | null;
  /** The coach bar and the step strip, docked outside the map (CommandView `dock`). */
  dock: ReactNode;
  /** The guided review step's photo, for the review frame's head ("photo 1 of 3"). */
  photoStep: { n: number; of: number } | null;
  /** The end screen. */
  overlay: ReactNode;
  /** Free play (the console on its own): the same engine, no coach bar; its clock control goes over the map. */
  free: boolean;
  clockBar: ReactNode;
  /**
   * The Mission goals strip (goals.ts), with the first-run tour: `reviewIds` are the photos flagged for
   * review on the console now (free play counts them all; the guided run its review step's). Null: no run.
   */
  goals: (reviewIds: readonly string[]) => ReactNode;
}

/** What the guided search changes in the fixtures (missionTime.ts): the seed, the read-back clue and whether it is mapped. */
export function guidedOptsFor(scenario: DemoFull | null, seed: string, choices: readonly { inject: string; option: string }[], user: readonly MissionEvent[]): GuidedOpts {
  const clue = storyClue(scenario);
  const readback = clue?.source === "radio" ? clue.id : null;
  const chosen = choices.find((c) => c.inject === "clue");
  const confirmed = user.some((e) => e.type === "clue.added" && e.ref === readback && !!(e.data as { confirmed?: boolean } | null)?.confirmed && !/logged/.test(e.summary));
  const survey = choices.find((c) => c.inject === "survey") as { option: string; watched?: boolean } | undefined;
  return { seed, readback, mapClue: chosen ? chosen.option !== "log" : confirmed, survey: survey ? { option: survey.option, watched: !!survey.watched } : null, dronesWait: dronesWait(scenario, choices) };
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
  guideHref = "#m/demo?guide=1",
  scenariosHref = "#scenarios",
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
  /** Start over on this seed (watch: the agent's line; free: free play again). */
  onRestart: (watch: boolean, free?: boolean) => void;
  /** Free play's ways out: the guided search on this scenario, the scenario cards. */
  guideHref?: string;
  scenariosHref?: string;
}): GuideRun {
  const guide = useGuide((x) => x.guide);
  const on = demo && !!guide;
  // free play: the clock runs on its own, every item shows, the console's own controls decide
  const free = on && !!guide!.free;
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
  // the run goes on past last light (every free team out through the night: guide.ts standingFrom) until the find
  const light = realOf(searchEnd(scenario), costs);
  const dark = clockMs >= realOf(lastLight(scenario), costs);
  const activeAt = active ? realOf(active.at, costs) : null;
  // the find recorded stops the mission clock where it is (no running on to last light behind the end screen)
  const findDone = choices.some((c) => c.inject === "find");
  // nothing runs until the scenario is in; with no decision ahead (a pass under way) the clock runs on, never jumps
  // (free play never waits on a decision: it runs on to the find, or to the end of the night)
  const hold = on && scenario && !guide!.ended ? (findDone ? clockMs : free ? light : Math.min(activeAt ?? light, light)) : null;
  const reached = on && !free && activeAt !== null && clockMs >= activeAt && activeAt <= light;
  // free play: every decision that has come up and is not made yet (they wait together in Needs you)
  const due = useMemo(() => (free ? list.filter((i) => !injectDone(i, choices) && realOf(i.at, costs) <= clockMs) : []), [free, list, choices, costs, clockMs]);
  const dueSince = useRef<Record<string, number>>({});
  const lastClock = useRef(0);
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
  // free play has no decision to run to: its beats are read a window ahead (FREE_WINDOW_MS), the next window
  // once the clock is through this one
  const [win, setWin] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (!free || hold === null) return setWin(null);
    setWin((w) => (w && clockMs >= w.from && clockMs < w.to && w.to <= hold ? w : { from: clockMs, to: Math.min(hold, clockMs + FREE_WINDOW_MS) }));
  }, [free, hold, clockMs]);
  const lapseFrom = free ? (win?.from ?? clockMs) : runFrom;
  const lapseTo = free ? (win?.to ?? null) : hold;
  const rows = useMemo(() => {
    if (!on || !scenario || lapseTo === null || lapseTo <= lapseFrom) return [];
    const at = onMissionClock(demoAt(scenario, iso(fixtureOf(lapseTo, costs)), user, guidedOptsFor(scenario, seed, choices, rawUser), { seed }), costs);
    return buildTimeline(at.events ?? [], at.teams ?? [], at.timeline ?? [])
      .map((e) => ({ at: new Date(e.at).getTime(), text: e.text, kind: e.kind, team: e.team, sector: e.sector, detail: e.detail }))
      .filter((e) => e.at > lapseFrom && e.at <= lapseTo)
      .sort((a, b) => a.at - b.at);
  }, [on, scenario, lapseTo, lapseFrom, costs, user, seed, choices, rawUser]);
  // one beat at a time: rows about one thing are one, a few a stretch (story.ts lapseBeats)
  const beats = useMemo(() => lapseBeats(rows, free ? FREE_MAX_BEATS : LAPSE.maxBeats), [rows, free]);
  const lapse: Lapse | null = useMemo(() => (lapseTo === null ? null : { from: lapseFrom, hold: lapseTo, beats: beats.map((b) => b.at) }), [lapseTo, lapseFrom, beats]);
  const lapseRef = useRef(lapse);
  lapseRef.current = lapse;
  const dwellUntil = useRef(0);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  // the clock: ten readings a second toward the next decision, a moment on each row as it lands, and it stops there
  // (and waits while a confirm is open: Leave the simulation?)
  const confirming = useConsole((s) => s.confirming);
  const running = on && !guide!.ended && !guide!.paused && !confirming && hold !== null && clockMs < hold;
  // the beat on the map goes once the decision is up
  const lapsing = on && !guide!.ended && hold !== null && clockMs < hold;
  useEffect(() => {
    if (!lapsing) useLapseBeat.setState({ beat: null });
  }, [lapsing]);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  // free play: a steady clock (FREE_MIN_PER_S mission minutes a second at 1×) that never stops at a decision,
  // but stops on each beat as it lands, as long as the guided run's (story.ts dwellAt), and shows it on the map
  useEffect(() => {
    if (!running || !free) return undefined;
    let last = performance.now();
    const id = window.setInterval(() => {
      const g = useGuide.getState().guide;
      const h = holdRef.current;
      const l = lapseRef.current;
      const now = performance.now();
      const dt = Math.min(250, now - last);
      last = now;
      if (!g || g.paused || h === null || now < dwellUntil.current) return;
      if (dwellUntil.current) {
        dwellUntil.current = 0;
        useLapseBeat.setState({ beat: null });
      }
      const to = Math.min(h, g.clock + dt * FREE_MIN_PER_S * 60 * g.speed);
      const next = l?.beats.find((b) => b > g.clock && b <= l.hold);
      if (l && next !== undefined && to >= next) {
        dwellUntil.current = now + dwellAt(l, g.speed);
        useLapseBeat.setState({ beat: beatsRef.current.find((b) => b.at === next) ?? null });
        useGuide.getState().setClock(next);
      } else useGuide.getState().setClock(to);
    }, 100);
    return () => window.clearInterval(id);
  }, [running, free]);
  useEffect(() => {
    if (!running || free) return undefined;
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
      if (r.beat) {
        dwellUntil.current = now + dwellAt(l, g.speed);
        useLapseBeat.setState({ beat: beatsRef.current.find((b) => b.at === r.clock) ?? null });
      }
      useGuide.getState().setClock(r.clock);
    }, 100);
    return () => window.clearInterval(id);
  }, [running, free]);
  /** Skip ahead: straight to the next decision, every row on the way landing at once. */
  const skip = useCallback(() => {
    dwellUntil.current = 0;
    useLapseBeat.setState({ beat: null });
    const l = lapseRef.current;
    if (l) useGuide.getState().setClock(l.hold);
  }, []);

  // last light with no find: the search suspends (no fail state)
  useEffect(() => {
    if (on && scenario && !guide!.ended && clockMs >= light && !reached) useGuide.getState().end();
  }, [on, guide?.ended, clockMs, light, reached]);

  // free play: each decision that has come up counts when it is made on the console (an answer on any
  // photo, the read-back confirmed, an approval, the find recorded), in any order
  useEffect(() => {
    if (!free || guide!.ended) return;
    // when each item reached Needs you (wall clock), for the end screen's decision time; a restart clears it
    if (clockMs < lastClock.current) dueSince.current = {};
    lastClock.current = clockMs;
    const now = Date.now();
    for (const i of due) for (const k of i.id === "triage" ? (i.cards ?? []).map((c) => `triage:${c.id}`) : [i.key]) dueSince.current[k] ??= now;
    for (const i of due) {
      if (i.id === "triage") {
        for (const tc of i.cards ?? []) {
          const a = answers[tc.id] as TriageAnswer | undefined;
          if (!a || choices.some((x) => x.key === `triage:${tc.id}`)) continue;
          useGuide.getState().choose(stamp(choiceFor(i, a, f, tc)));
          follow(tc, a);
          logAnswer(i, tc.id, a, operatorName());
        }
        continue;
      }
      const c = choiceFromConsole(i, input, answers, f);
      if (!c) continue;
      useGuide.getState().choose(stamp(c));
      if (i.id === "find" && i.find) carryOut(i.find.team, i.find.sector);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free, due, input, answers, f]);
  /** Free play: a choice with when its item reached Needs you. */
  function stamp(c: Choice): Choice {
    return freeRef.current.free ? { ...c, shownAt: c.shownAt ?? dueSince.current[c.key] } : c;
  }

  // a decision made on the console itself counts
  useEffect(() => {
    if (!on || !active || !reached) return;
    const c = choiceFromConsole(active, input, answers, f);
    if (c) {
      useGuide.getState().choose(c);
      // what follows from it, as when it is made by key or by Watch instead
      if (active.id === "triage" && c.card) {
        const tc = active.cards?.find((x) => x.id === c.card);
        if (tc) {
          follow(tc, c.option as TriageAnswer);
          logAnswer(active, tc.id, c.option as TriageAnswer, operatorName());
        }
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

  // triage: each photo opens large in the review frame, the subject's description beside it; closed after
  const openedReview = useRef(false);
  const triageCard = reached && active?.id === "triage" ? (card?.id ?? null) : null;
  useEffect(() => {
    if (triageCard) {
      useConsole.getState().openReview(triageCard);
      openedReview.current = true;
    } else if (openedReview.current) {
      openedReview.current = false;
      useConsole.getState().closeReview();
    }
  }, [triageCard]);

  // phones: the decision's panel in front
  useEffect(() => {
    if (reached && (active?.id === "triage" || active?.id === "assign" || active?.id === "clue" || active?.id === "wind")) useConsole.getState().setTab("needs");
  }, [reached, active?.id]);

  // the step a card's button answers, read when it is pressed (the card's own Approve is "send only")
  const stepRef = useRef<{ active: Inject | null; reached: boolean; f: number }>({ active: null, reached: false, f: 0 });
  stepRef.current = { active, reached: !!reached, f };
  const freeRef = useRef<{ free: boolean; due: readonly Inject[]; f: number }>({ free: false, due: [], f: 0 });
  freeRef.current = { free, due, f };
  // a decision being carried out (Send all's approvals, one after another): it was recorded once already, and
  // the step that comes up meanwhile must not take its approvals as its own decision
  const carrying = useRef(false);
  const decide: Decide = useCallback(async (pid, decision, by, reason, edits0) => {
    const m = useMission.getState();
    const p = m.proposals.find((x) => x.id === pid);
    // an edit to the proposal's own team is no edit (the log said "edited from Team One" with nothing changed)
    const edits = edits0 && edits0.team === p?.target.team ? (({ team: _t, ...rest }) => (Object.keys(rest).length ? rest : undefined))(edits0) : edits0;
    // recorded before the team's move lands, so the step is this decision (not a move made on the side)
    const st = stepRef.current;
    const watched = by === WATCH_BY;
    if (decision === "approve" && !carrying.current && st.reached && st.active?.proposal === pid && (st.active.id === "assign" || st.active.id === "wind") && !watched) {
      const team = edits?.team && edits.team !== p?.target.team ? edits.team : null;
      const c = choiceFor(st.active, st.active.id === "wind" ? "recall" : team ? `team:${team}` : "approve", st.f);
      useGuide.getState().choose(team ? { ...c, label: `${m.teams.find((t) => t.id === team)?.callsign ?? team} to ${p?.target.sector ?? ""}` } : c);
    }
    // free play: the approval is the decision of whichever item it answers (they wait together)
    const fr = freeRef.current;
    const i = fr.free && decision === "approve" && !carrying.current && !watched ? fr.due.find((x) => x.proposal === pid && (x.id === "assign" || x.id === "wind")) : undefined;
    if (i) {
      const team = edits?.team && edits.team !== p?.target.team ? edits.team : null;
      const c = choiceFor(i, i.id === "wind" ? "recall" : team && i.key === "assign" ? `team:${team}` : "approve", fr.f);
      useGuide.getState().choose(stamp(team ? { ...c, label: `${m.teams.find((t) => t.id === team)?.callsign ?? team} to ${p?.target.sector ?? ""}` } : c));
    }
    await m.decide(pid, decision, by, reason, edits);
    if (decision === "approve" && p?.kind === "assign_sector" && p.target.sector) {
      const team = edits?.team ?? p.target.team;
      if (team) await useMission.getState().assign(team, p.target.sector, by);
    }
  }, []);

  /** A team free for a side job (not `not`). */
  function freeTeam(not?: string) {
    const teams = useMission.getState().teams;
    return teams.find((t) => t.id !== not && (t.status === "standby" || t.status === "assigned")) ?? teams.find((t) => t.id !== not);
  }
  /** What a triage answer leads to beyond the review itself: another person (or a group) is a witness lead, on every photo alike. */
  function follow(c: { id: string }, a: TriageAnswer) {
    const m = useMission.getState();
    if (a === "not_subject" || a === "group") {
      const at = candidatePosition(cache, c.id);
      if (at) {
        const text = a === "group" ? `witness: a group of people in photo ${at.frame}, ask what they saw (the subject may be with them)` : `witness: another person on the ground in photo ${at.frame}, ask what they saw`;
        m.emit("clue.added", `other: ${text}`, `w-${c.id}`, { kind: "other", text, lat: at.lat, lon: at.lon, at_team_position: false, radius_m: 30, reliability: "low", reported_by: "command", source: "form", confirmed_by_turn: null, id: `w-${c.id}`, at: iso(f), confirmed: true });
      }
    }
  }
  /** A photo's answer in the log, with who gave it (round 3: the answers were in no decision line). */
  function logAnswer(i: Inject, id: string, a: TriageAnswer, by: string) {
    const label = TRIAGE_OPTIONS.find((o) => o.id === a)?.label ?? a;
    const who = by === WATCH_BY ? `${WATCH_BY} chose it` : "answered by you";
    useMission.getState().emit("mission.note", `${photoTitle(i, id)}: ${label} (${who})`, id, { action: "photo_answer", by, answer: a });
  }
  /** The find recorded: the nearest other team goes to carry out. */
  function carryOut(team: string, sector: string) {
    // (a radio call only: who goes is the radio's; the board shows the finding team on the carry-out)
    const carry = freeTeam(team);
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
      useGuide.getState().choose(stamp(choiceFor(i, optionId, f, c, watched)));
      // who decided, in the log: the visitor, or Watch instead (never "You approved" for Watch instead's)
      const by = watched ? WATCH_BY : operatorName();
      const teams = m.teams;
      if (i.id === "triage" && c) {
        const a = optionId as TriageAnswer;
        answer(c.id, a);
        follow(c, a);
        logAnswer(i, c.id, a, by);
      } else if (i.id === "clue") {
        const clue = storyClue(scenario);
        if (!clue) return;
        const team = teams.find((t) => t.id === clue.reported_by);
        if (optionId === "bearing") {
          if (team) void m.call(team.id, "say again your bearing to it, over.");
          m.emit("clue.added", `${clue.id} confirmed with a bearing`, clue.id, { ...clue, confirmed: true, reliability: "medium", decided_by: by });
        } else if (optionId === "log") {
          // logged as said: not confirmed, the map unchanged, and no longer waiting for a read-back
          m.emit("clue.added", `${clue.id} logged without mapping`, clue.id, { ...clue, confirmed: false, logged: true, decided_by: by });
        } else {
          if (team) void m.call(team.id, `read back: ${clue.text}. Confirm, over.`);
          m.emit("clue.added", `${clue.id} confirmed`, clue.id, { ...clue, confirmed: true, decided_by: by });
        }
      } else if ((i.id === "assign" || i.id === "wind") && i.proposal) {
        const team = optionId.startsWith("team:") ? optionId.slice(5) : undefined;
        const pid = i.proposal;
        // the proposals as they stand at the click: what the button said is what is approved
        const sights = optionId === "all" ? m.proposals.filter((x) => x.status === "pending" && isSightingProposal(x)).map((x) => x.id) : [];
        carrying.current = true;
        void (async () => {
          try {
            // Send all takes in a sighting still waiting for a team: the nearest team goes there first, approved by name
            for (const id of sights) await decide(id, "approve", by);
            await decide(pid, "approve", by, undefined, team ? { team } : undefined);
          } finally {
            carrying.current = false;
          }
        })();
      } else if (i.id === "survey" && (optionId === "planner" || optionId === "serpentine")) {
        // the survey choice is a decision in the log like the others (round 3: it was in none of them)
        const who = watched ? `${WATCH_BY} chose it` : "you chose it";
        m.emit("mission.note", `Survey: ${optionId === "planner" ? "the AI's flight lines, the likeliest sectors first" : "a lawnmower pattern over the whole grid (+12 min)"} (${who})`, null, { action: "survey", by, option: optionId });
      } else if (i.id === "survey" && optionId === "override") {
        m.emit("mission.note", `Drones fly anyway: an override of the grounding (${scenario?.data.conditions?.flyability_reason ?? "over the drones' limits"}), approved by ${by}`, null, { action: "fly_override", by });
      } else if (i.id === "survey" && optionId === "wait") {
        m.emit("mission.note", `Drones stay on the ground for the wind; the ground teams go first (by ${by})`, null, { action: "drones_wait", by });
      } else if (i.id === "wind" && optionId === "finish") {
        m.emit("mission.note", `Drones finish the flight line in gusts over the limit: an override, approved by ${by}`, null, { action: "fly_override", by });
      } else if (i.id === "link") {
        const who = watched ? "Watch instead chose it" : "you chose it";
        if (optionId === "relay") m.emit("mission.note", `Relay: ${i.link?.relayName ?? "a second drone"} holds over the ridge for ${i.link?.lostName ?? "the drone"} that lost its link; its own flight line stops (${who})`, null, { action: "relay", by, drone: i.link?.relay ?? null, lost: i.link?.drone ?? null });
        else m.emit("mission.note", `${i.link?.lostName ?? "The drone"} finishes its flight line on its own; its photos arrive when the link comes back (${who})`, null, { action: "let-finish", by });
      } else if (i.id === "find" && i.find) {
        const { team, sector } = i.find;
        if (optionId === "confirm") void m.call(team, "confirm the subject's description, over.");
        void m.found(team, sector, by);
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
    if (!on || !guide!.watch || !active || !reached || guide!.ended || confirming) return undefined;
    const ag = agentOption(active, card);
    const t1 = window.setTimeout(() => setStatus(`AI's choice: ${ag.label}`), 3000);
    const t2 = window.setTimeout(() => {
      setStatus(null);
      perform(active, ag.id, true);
    }, 4200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, guide?.watch, guide?.ended, active?.key, card?.id, reached, confirming]);

  // the find marked: what you did opens at once (the owner: a 2.5 s wait here read as lag)
  useEffect(() => {
    if (!on || !findDone || guide!.ended || confirming) return;
    useGuide.getState().end();
  }, [on, findDone, guide?.ended, confirming]);

  // ---- the mission goals (goals.ts), read live from the engine's state ----
  // teams that went past their check-in at any time this run (a restart, the clock going back, forgets them)
  const everOverdue = useRef<Set<string>>(new Set());
  const goalClock = useRef(0);
  const lastOver = useRef<Set<string>>(new Set());
  // the photos flagged on the console, as the strip last read them (free play: every one landed)
  const reviewRef = useRef<{ flagged: number; answered: number }>({ flagged: 0, answered: 0 });
  const realLight = realOf(lastLight(scenario), costs);
  function goalsNow(reviewIds: readonly string[] | null, foundAt: number | null = null): Goal[] {
    const m = useMission.getState();
    if (clockMs < goalClock.current) everOverdue.current = new Set();
    const step = clockMs - goalClock.current;
    goalClock.current = clockMs;
    const board = teamOrder(m.teams, m.events, new Date(clockMs), m.mission?.check_in_min ?? 30, m.timeline ?? []);
    const over = overdueTeams(board);
    // a team counts as past its check-in when two readings of a running clock say so: right after a jump of the
    // clock (Skip ahead) the mission's events catch up a frame later, and that frame is no check-in missed
    const now = new Set(over.map((x) => x.team.id));
    if (step > 0 && step < 5 * 60_000) for (const id of now) if (lastOver.current.has(id)) everOverdue.current.add(id);
    lastOver.current = now;
    const out = board.filter((x) => x.team.status !== "off_duty");
    // the photos: the guided run's review step (once it has come up), free play's every photo flagged
    const tri = list.find((i) => i.id === "triage");
    if (reviewIds && free) reviewRef.current = { flagged: reviewIds.length, answered: reviewIds.filter((id) => !!answers[id]).length };
    const photos = free ? reviewRef.current : { flagged: tri && realOf(tri.at, costs) <= clockMs ? (tri.cards?.length ?? 0) : 0, answered: choices.filter((c) => c.inject === "triage").length };
    const radio = m.clues.filter((c) => c.source === "radio");
    const found = foundAt ?? (findDone || m.mission?.status === "found" ? clockMs : null);
    return missionGoals({
      found,
      lastLight: realLight,
      now: clockMs,
      photos,
      clues: { total: radio.length, confirmed: radio.filter((c) => c.confirmed && !isLogged(c)).length },
      teams: { total: out.length, overdueNow: over.length, everOverdue: [...everOverdue.current].filter((id) => out.some((x) => x.team.id === id)).length },
    });
  }

  // ---- what is on screen ----
  const subject = subjectOf(scenario);
  const callsign = (id: string | null) => scenario?.data.teams?.find((t) => t.id === id)?.callsign ?? id ?? "";
  const ids: string[] = [];
  // a later assignment (a team back from its pass) or the find shows on the strip only once it is up
  const future = (i: Inject) => (i.id === "find" || i.key.startsWith("assign-")) && !injectDone(i, choices) && !(reached && active?.key === i.key);
  for (const i of list) {
    if (!future(i) && !ids.includes(i.id)) ids.push(i.id);
  }
  if (subject && !ids.includes("find")) ids.push("find");
  const pips = ids.map((id) => {
    // a step is ticked once the decisions of it that have come up are made (the cold test: a later
    // assignment, not yet up, kept step 4 unticked after it was made)
    const all = list.filter((i) => i.id === id && !future(i));
    const done = all.length > 0 && all.every((i) => injectDone(i, choices)) && !(reached && active?.id === id);
    const current = reached && active?.id === id;
    const count = id === "assign" ? all.filter((i) => injectDone(i, choices) || (reached && active?.key === i.key)).length : undefined;
    return { id, label: PIPS.find((p) => p.id === id)?.label ?? id, state: (done ? "done" : current ? "current" : "next") as "done" | "current" | "next", count };
  });
  // the step: the decision waiting, or (between decisions) the one the clock runs to
  const next = active ?? null;
  const n = Math.max(1, ids.indexOf(next?.id ?? "") + 1);
  const pip = PIPS.find((p) => p.id === next?.id)?.label ?? "";
  const triage = active?.id === "triage" && card ? active.cards!.indexOf(card) + 1 : 0;
  // a team back from its pass brings the assign step up again: said as a follow-up, not a jump back to step 4
  const again = next?.id === "assign" && next.key !== "assign";
  const step = again ? `Follow-up to step ${n} · ${pip} again: a team is back` : `Step ${n} of ${ids.length} · ${pip}${triage ? `, photo ${triage} of ${active!.cards!.length}` : ""}`;
  // while the clock runs: the decision it runs to, briefly (the strip above numbers the steps)
  const heading = reached ? step : next && pip ? `Next: ${again ? `${pip} again` : pip}` : "The teams search";

  // between decisions: the last cost being spent, or what leads to the next decision
  const lastCost = [...choices].reverse().find((c) => c.costMs > 0);
  const inCost = lastCost ? clockMs >= realOf(lastCost.f, costs) && clockMs < realOf(lastCost.f, costs) + lastCost.costMs : false;
  const progress = hold !== null && hold > runFrom ? (clockMs - runFrom) / (hold - runFrom) : 0;
  // the pass under way, in words (never where the subject is)
  const out = passesFrom(seed, subject, user).find((p) => !p.cut && p.start <= f && p.end > f);
  const walking = out ? `${callsign(out.team)} ${f < out.arrive ? `walks to ${out.sector}` : `sweeps ${out.sector} at ${podLabel(out.pod)} a pass`}.` : null;
  const night = dark ? "Last light has gone: every free team searches on through the night on the AI's picks. " : "";
  const lead = night + (inCost && lastCost ? `${lastCost.label}: ${lastCost.costMs / 60_000} min on the clock.` : (walking ?? active?.lead ?? "The teams search; the clock runs until the radio has news."));
  // the time-lapse's caption: the row that landed last on this run, with its time (cause, then effect)
  // (a row more than ten mission minutes old gives way to what is under way now)
  const landed = [...beats].reverse().find((b) => b.at <= clockMs && clockMs - b.at <= 10 * 60_000);
  // what happened and what it means for the search, in one plain line (caption.ts); the clock beside it reads the time
  const caption = landed ? beatCaption(landed) : lead;
  // free play: the beat the clock stops on, said on its clock bar
  const beatNow = useLapseBeat((x) => x.beat);

  // triage: the card's own answers (no buttons on the bar), so A gives the agent's reference answer; Object
  // (O) is left to the card, which asks for the object's type
  const options: GuideOption[] = !reached || !active ? [] : active.id === "triage" ? (card ? TRIAGE_OPTIONS.filter((o) => o.id !== "object").map((o) => ({ key: o.key, id: o.id, label: o.label, effect: triageEffect(card, o.id).effect, costMin: triageEffect(card, o.id).costMin, agent: o.id === card.line, on: "the review frame's answers" })) : []) : active.options.map((o) => ({ ...o }));
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
  // the score out of 100 (goals.ts): the goals at the end and the time to find against the manual line and the AI's
  const score: Score | null =
    on && guide!.ended && wash
      ? (() => {
          const cols = versus?.sightline.columns ?? [];
          const col = (k: "manual" | "you" | "agent") => cols.find((c) => c.key === k);
          const call = new Date(CHECKPOINTS[0]!.at).getTime();
          const you = col("you")?.findMin ?? (wash.outcome.foundAt !== null ? (wash.outcome.foundAt - call) / 60_000 : null);
          return missionScore(goalsNow(null, wash.outcome.foundAt), { you, manual: col("manual")?.findMin ?? null, agent: col("agent")?.findMin ?? (choices.every((c) => c.agent) ? you : null), lastLight: (realLight - call) / 60_000 });
        })()
      : null;
  // the best score on this scenario, kept once per run that was the visitor's own (Watch instead's is the AI's)
  const mine = choices.some((c) => !c.watched);
  const [best, setBest] = useState<{ best: number | null; beat: boolean; kept: boolean } | null>(null);
  const scoreTotal = score?.total ?? null;
  useEffect(() => {
    if (scoreTotal === null) return setBest(null);
    setBest(mine ? { ...keepBest(free ? `${seed}:free` : seed, scoreTotal), kept: true } : { best: null, beat: false, kept: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTotal]);
  // Needs you (its `highlight`): the item this step is about ringed, the rest dimmed and out of reach; "none" between decisions
  const readback = storyClue(scenario);
  const needsHighlight = !reached || !active ? "none" : active.id === "triage" ? "review" : active.id === "clue" && readback ? `clue-${readback.id}` : (active.id === "assign" || active.id === "wind") && active.proposal ? active.proposal : active.id === "find" && active.find ? `report-${active.find.team}` : "none";

  // the end screen; "Stay on the console" puts it away and the console stays on this run, clock stopped
  const followed = choices.length > 0 && choices.every((c) => c.agent);
  const overlay =
    on && guide!.ended && wash && !guide!.closed ? (
      <GuideEnd
        wash={wash}
        versus={versus}
        sectors={scenario?.data.sectors ?? []}
        subject={subject}
        scenario={scenarioName}
        seed={seed}
        callsign={callsign}
        onReplay={() => onRestart(false, free)}
        onWatchAgent={() => onRestart(true)}
        followed={followed}
        free={free}
        onReport={() => {
          useGuide.getState().close();
          onReport();
        }}
        onTrace={() => {
          useGuide.getState().close();
          onTrace();
        }}
        onClose={() => useGuide.getState().close()}
        score={score ? { score, best: best?.best ?? null, beat: !!best?.beat, kept: !!best?.kept } : null}
      />
    ) : null;

  // the step's card's main button in Needs you: the same "send all" as the coach bar (one control per action)
  const allOpt = reached && active?.id === "assign" && active.proposal ? active.options.find((o) => o.id === "all") : undefined;
  const only = reached && active?.id === "assign" ? active.options.find((o) => o.id === "approve") : undefined;
  // free play: the same Send all on the card of the first assignment waiting
  const freeAssign = free ? due.find((i) => i.id === "assign" && i.proposal && i.options.some((o) => o.id === "all")) : undefined;
  const cardLead: GuideRun["lead"] = freeAssign
    ? { id: freeAssign.proposal!, label: freeAssign.options.find((o) => o.id === "all")!.label, onClick: () => perform(freeAssign, "all"), second: freeAssign.options.find((o) => o.id === "approve")?.label ?? null }
    : allOpt && active?.proposal
      ? { id: active.proposal, label: allOpt.label, onClick: () => perform(active, "all"), second: only?.label ?? null }
      : null;
  // the count Needs you shows in its head (one source: NeedsYou useNeedsTotal)
  const pendingCount = useNeedsTotal((x) => x.total);
  const clockBar =
    free && !guide!.ended ? (
      <FreeClock
        clock={clockText(iso(clockMs), DEMO_TZ)}
        paused={!!guide!.paused}
        onPause={() => useGuide.getState().pause()}
        speed={guide!.speed}
        speeds={SPEEDS}
        onSpeed={(x) => useGuide.getState().setSpeed(x as Speed)}
        onRestart={() => onRestart(false, true)}
        guideHref={guideHref}
        scenariosHref={scenariosHref}
        waiting={pendingCount}
        atCall={clockMs <= new Date(CHECKPOINTS[0]!.at).getTime()}
        caption={beatNow ? beatCaption(beatNow) : null}
      />
    ) : null;

  const dock = !on || (free && !guide!.ended) ? null : guide!.ended ? (
    guide!.closed ? (
      <div role="region" aria-label="Simulation ended" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-solid px-3.5 py-2 text-small">
        <span className="text-text">{wash?.outcome.foundAt != null ? `Found at ${clockText(iso(wash.outcome.foundAt), DEMO_TZ)}: the mission clock stopped there.` : "The simulation has ended."}</span>
        <button type="button" onClick={() => useGuide.getState().close(false)} className="sl-tap rounded-full border border-border px-3 py-0.5 text-text hover:bg-surface-strong">
          What you did
        </button>
        <button type="button" onClick={() => onRestart(false, free)} className="sl-tap rounded-full border border-border px-3 py-0.5 text-text hover:bg-surface-strong">
          Restart
        </button>
        <button type="button" onClick={onLeave} className="sl-tap ml-auto text-text-2 underline underline-offset-2 hover:text-text">
          Back to the scenarios
        </button>
      </div>
    ) : null
  ) : (
    <GuideMark
      mode={reached ? "call" : "watch"}
      heading={heading}
      text={text}
      strip={<GuideStrip pips={pips} at={iso(clockMs)} call={reached} paused={!!guide!.paused} announce={announce} />}
      target={reached && active ? (card ? ['[data-review-frame] [aria-label="Answer"]', `[data-candidate="${card.id}"]`, ...[active.target].flat()] : active.target) : []}
      why={reached ? (card ? card.says : active?.id === "assign" || active?.id === "wind" ? undefined : active?.agentSays) : undefined}
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
      onRestart={() => onRestart(false)}
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
    proposals: (all) => (on && !free ? all.filter((p) => p.status !== "pending" || (reached && p.id === active?.proposal) || isSightingProposal(p)) : [...all]),
    cards: (all) => (on && !free ? (reached && card ? all.filter((c) => c.id === card.id) : []) : [...all]),
    proposal: on && reached ? (active?.proposal ?? null) : null,
    needsHighlight: on && !free && !guide!.ended ? needsHighlight : null,
    decide,
    lead: on ? cardLead : null,
    photoStep: on && reached && active?.id === "triage" && card ? { n: active.cards!.indexOf(card) + 1, of: active.cards!.length } : null,
    dock,
    overlay,
    free,
    clockBar,
    goals: (reviewIds) =>
      on && scenario ? (
        <>
          <GoalsStrip goals={goalsNow(reviewIds)} />
          {!guide!.ended && <Tour />}
        </>
      ) : null,
  };
}

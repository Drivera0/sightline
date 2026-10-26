// The guided search on the console (`#m/demo?guide=1`): the clock that runs to each decision and waits
// there, the mark that asks for it, what each option does on the console, "Watch instead", and the end
// screen. guide.ts says what the decisions are, sim.ts what follows from them, missionTime.ts what the
// console shows. LiveMission mounts it with the story wiring. Built by lane A.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { subjectOf, type DemoFull, type GuidedOpts } from "./missionTime";
import { GuideStrip } from "./Scrubber";
import { fixtureOf, passesFrom, realOf, type Cost } from "./sim";
import { guideStep, useGuide, useStory } from "./story";
import { REGION, STORY_NOT_A_PERSON, storyClue } from "./storyCopy";

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
  imageUrl,
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
  imageUrl: (rel: string) => string;
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

  // the clock: runs toward the next decision ten times a second, and stops there
  const running = on && !guide!.ended && !guide!.paused && hold !== null && clockMs < hold;
  useEffect(() => {
    if (!running || hold === null) return undefined;
    const id = window.setInterval(() => {
      const g = useGuide.getState().guide;
      if (g) useGuide.getState().setClock(guideStep(g.clock, hold, 100, prefersReducedMotion() && activeAt !== null));
    }, 100);
    return () => window.clearInterval(id);
  }, [running, hold]);

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
      setHint(null);
    }
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
      const free = (not?: string) => teams.find((t) => t.id !== not && (t.status === "standby" || t.status === "assigned")) ?? teams.find((t) => t.id !== not);
      if (i.id === "triage" && c) {
        const a = optionId as TriageAnswer;
        answer(c.id, a === "not_subject" ? "not_person" : a);
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
        m.emit("mission.note", `Relay: a second drone holds over the ridge for the one that lost its link; its own leg stops (by ${by})`, null, { action: "relay", by });
      } else if (i.id === "find" && i.find) {
        const { team, sector } = i.find;
        if (optionId === "confirm") void m.call(team, "confirm the subject's description, over.");
        void m.found(team, sector);
        const carry = free(team);
        if (carry) void m.call(carry.id, `carry-out to ${sector}, over.`);
      }
      setHint(null);
    },
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
  const n = Math.max(1, ids.indexOf(active?.id ?? "") + 1);
  const pip = PIPS.find((p) => p.id === active?.id)?.label ?? "";
  const triage = active?.id === "triage" && card ? active.cards!.indexOf(card) + 1 : 0;
  const heading = reached ? `Decision ${n} of ${ids.length} · ${pip}${triage ? `, ${triage} of ${active!.cards!.length}` : ""}` : "Mission clock running";
  const crop = card ? demoCards(cache, landedFrames(cache, cache?.survey.frames.length ?? 0), imageUrl, true).find((x) => x.id === card.id)?.crop : undefined;

  // between decisions: the last cost being spent, or what leads to the next decision
  const lastCost = [...choices].reverse().find((c) => c.costMs > 0);
  const inCost = lastCost ? clockMs >= realOf(lastCost.f, costs) && clockMs < realOf(lastCost.f, costs) + lastCost.costMs : false;
  const prev = choices.length ? realOf(choices.at(-1)!.f, costs) : (guide?.clock ?? 0);
  const progress = hold !== null && hold > prev ? (clockMs - prev) / (hold - prev) : 0;
  // the pass under way, in words (never where the subject is)
  const out = passesFrom(seed, subject, user).find((p) => !p.cut && p.start <= f && p.end > f);
  const walking = out ? `${callsign(out.team)} ${f < out.arrive ? `walks to ${out.sector}` : `sweeps ${out.sector} at POD ${out.pod.toFixed(2)} a pass`}.` : null;
  const lead = inCost && lastCost ? `${lastCost.label}: ${lastCost.costMs / 60_000} min on the clock.` : (walking ?? active?.lead ?? "The teams search; the clock runs until the radio has news.");

  let options: GuideOption[] = [];
  if (reached && active) {
    if (active.id === "triage" && card)
      options = TRIAGE_OPTIONS.map((o) => {
        const e = triageEffect(card, o.id);
        return { key: o.key, id: o.id, label: o.label, effect: e.effect, costMin: e.costMin, agent: false };
      });
    else options = active.options.map((o) => ({ ...o }));
  }
  const text = reached && active ? active.prompt : lead;
  const announce = reached && active ? `Your call, ${pip}: ${active.prompt}` : `Watch this: ${lead}`;
  const wash = useMemo(() => (on && guide!.ended ? hotWash(input, list) : null), [on, guide?.ended, input, list]);
  const versus = useMemo(() => (wash ? compare(input, wash, lastLight(scenario)) : null), [wash, input, scenario]);

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
      target={reached && active ? (card ? [`[data-candidate="${card.id}"]`, ...[active.target].flat()] : active.target) : [`${REGION.map} figure`, REGION.map]}
      agentSays={reached ? (card ? card.says : active?.agentSays) : undefined}
      image={reached && card && crop ? { src: crop, alt: `Candidate ${card.id}` } : undefined}
      options={options}
      onPick={(id) => active && perform(active, id)}
      onMap={active?.options.some((o) => o.id === "map") ? () => active && perform(active, "map") : undefined}
      progress={reached ? undefined : progress}
      status={status ?? hint ?? undefined}
      watching={!!guide!.watch}
      onWatch={() => useGuide.getState().setWatch(true)}
      onTakeOver={() => useGuide.getState().setWatch(false)}
      paused={!!guide!.paused}
      onPause={() => useGuide.getState().pause()}
      onExit={onLeave}
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
    decide,
    strip: on && !guide!.ended ? <GuideStrip pips={pips} at={iso(clockMs)} call={reached} paused={!!guide!.paused} announce={announce} /> : null,
    overlay,
  };
}

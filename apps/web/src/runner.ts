import { DOMAINS, type Domain, type Environment, type Incident, type Run, type TimedEvent } from '@tv/core';
import { MAX_SHARED_TICKS } from './share';
import { useStore } from './store';

const PUBLISH_EVERY = 0.2;
// How long a frame may spend rebuilding a live session's run in the background: under half a 60 fps frame.
const REBUILD_BUDGET_MS = 6;
const byTick = (a: TimedEvent, b: TimedEvent) => a.at - b.at;
const play = (run: Run, event: TimedEvent) => ('incident' in event ? run.inject(event.incident) : run.apply(event.patches));
// Keeps a queue in tick order from "from" on, with a new action after any already at its tick, as the session logged them.
const insert = (queue: TimedEvent[], from: number, event: TimedEvent) => {
  let i = queue.length;
  while (i > from && queue[i - 1].at > event.at) i--;
  queue.splice(i, 0, event);
};
const HISTORY = 60;

// '99.4%', '84 ms' and 12 all chart as their leading number
const numeric = (value: string | number) => (typeof value === 'number' ? value : parseFloat(value.replace(/,/g, '')));

class Runner {
  run: Run | null = null;
  domain: Domain | null = null;
  seed = 1;
  running = false;
  speed = 1;
  alpha = 0;
  private acc = 0;
  private sincePublish = 0;
  private statHistory: Record<string, number[]> = {};
  private sampledTick = -1;
  // A live session's actions that are still ahead of this screen's clock, applied when the run reaches their tick.
  private pending: TimedEvent[] = [];
  // A run being rebuilt from the session's log a slice at a time, swapped in once it catches up, so the screen never freezes.
  private rebuilding: { environment: Environment; seed: number; run: Run; queue: TimedEvent[]; next: number; target: number } | null = null;
  /** Hears every action taken on this screen and every play, pause or speed change, so a live session can share them. */
  onLocal: ((event: TimedEvent) => void) | null = null;
  onTransport: ((running: boolean, speed: number, tick: number) => void) | null = null;

  load(environment: Environment, seed = 1) {
    const domain = DOMAINS[environment.domain];
    this.domain = domain;
    this.run = domain.createRun(domain.compile(environment.spec), seed);
    this.seed = seed;
    this.pending = [];
    this.rebuilding = null;
    this.acc = 0;
    this.alpha = 0;
    this.running = true;
    this.statHistory = {};
    this.sampledTick = -1;
    this.publish();
  }

  // Rebuilds a run from its event log in the same order evaluate() uses, so a shared run lands on exactly the same state.
  replay(environment: Environment, seed: number, tick: number, events: TimedEvent[]) {
    this.load(environment, seed);
    const run = this.run!;
    const queue = [...events].sort((a, b) => a.at - b.at);
    let next = 0;
    for (let t = 0; t < Math.min(tick, MAX_SHARED_TICKS); t++) {
      while (next < queue.length && queue[next].at <= t) {
        const event = queue[next++];
        if ('incident' in event) run.inject(event.incident);
        else run.apply(event.patches);
      }
      run.step();
    }
    if (events.some((e) => 'patches' in e)) useStore.getState().bumpStructure();
    this.publish();
  }

  clear() {
    this.run = null;
    this.domain = null;
    this.running = false;
  }

  frame(dt: number) {
    this.advanceRebuild(REBUILD_BUDGET_MS);
    const { run, domain } = this;
    if (!run || !domain) return;
    this.applyDue(run);
    if (this.running) {
      const stepTime = 1 / (domain.ticksPerSecond * this.speed);
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= stepTime) {
        if (run.tick >= MAX_SHARED_TICKS) {
          this.stopAtLimit();
          break;
        }
        run.step();
        this.applyDue(run);
        this.acc -= stepTime;
      }
      this.alpha = this.running ? this.acc / stepTime : 0;
    }
    this.sincePublish += dt;
    if (this.sincePublish >= PUBLISH_EVERY) {
      this.sincePublish = 0;
      this.publish();
    }
  }

  private publish() {
    const { run } = this;
    if (!run) return;
    const stats = run.telemetry();
    // Sample once per tick, so a paused run doesn't flatten the sparklines
    if (run.tick !== this.sampledTick) {
      this.sampledTick = run.tick;
      const next: Record<string, number[]> = {};
      for (const stat of stats) {
        const value = numeric(stat.value);
        const past = this.statHistory[stat.label] ?? [];
        next[stat.label] = Number.isFinite(value) ? [...past.slice(1 - HISTORY), value] : past;
      }
      this.statHistory = next;
    }
    useStore.getState().setTelemetry({
      tick: run.tick,
      stats,
      breakables: run.breakables(),
      running: this.running,
      speed: this.speed,
      statHistory: this.statHistory,
    });
  }

  // A run that went on past what a screen can replay couldn't be shared, saved or joined, so it pauses at the limit and says why.
  // Every screen in a live session reaches the same tick, so each pauses on its own; nothing needs relaying.
  private stopAtLimit() {
    this.running = false;
    this.acc = 0;
    this.publish();
    useStore.getState().addMessage({
      role: 'app',
      text: `Paused at tick ${MAX_SHARED_TICKS.toLocaleString('en-US')}, the longest run a link or a live session can replay, so this one can still be shared and joined. Rebuild it to run again from the start.`,
    });
  }

  /** Whether the run sits at the replay limit, where it can't step any further. */
  atLimit() {
    return (this.run?.tick ?? 0) >= MAX_SHARED_TICKS;
  }

  toggle() {
    if (!this.running && this.atLimit()) {
      this.stopAtLimit();
      return;
    }
    this.running = !this.running;
    this.publish();
    this.onTransport?.(this.running, this.speed, this.run?.tick ?? 0);
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.publish();
    this.onTransport?.(this.running, this.speed, this.run?.tick ?? 0);
  }

  /** Someone else in a live session played, paused or changed speed. */
  setTransport(running: boolean, speed: number) {
    this.running = running;
    this.speed = speed;
    this.publish();
  }

  inject(incident: Incident) {
    const { run } = this;
    if (!run) return false;
    // A break steps the run once, which would carry it past the replay limit.
    if (this.atLimit()) {
      this.stopAtLimit();
      return false;
    }
    run.inject(incident);
    const logged = run.log.at(-1);
    if (logged) this.carryIntoRebuild(logged);
    run.step();
    this.publish();
    if (logged) this.onLocal?.(logged);
    return true;
  }

  applyPatches(patches: unknown[]) {
    if (!this.run || !patches.length) return;
    this.run.apply(patches);
    const logged = this.run.log.at(-1);
    if (logged) this.carryIntoRebuild(logged);
    useStore.getState().bumpStructure();
    this.publish();
    if (logged) this.onLocal?.(logged);
  }

  // Something done on this screen while a rebuild is under way goes into the rebuild too, or the swap would drop it.
  private carryIntoRebuild(event: TimedEvent) {
    const job = this.rebuilding;
    if (!job) return;
    if (event.at >= job.run.tick) insert(job.queue, job.next, event);
    else this.startRebuild(job.environment, job.seed, [...job.queue, event], job.target);
  }

  /**
   * Someone else in a live session acted. "log" is the session's whole action history, ending with "event".
   * An action still ahead of this screen's clock is simply applied when the run reaches its tick: the same result as a replay,
   * at no cost. One this screen has already passed means rebuilding the run from the log, which happens in the background.
   */
  receive(environment: Environment, seed: number, log: TimedEvent[], event: TimedEvent) {
    const run = this.run;
    if (!run) return;
    const rebuild = this.rebuilding;
    if (rebuild) {
      if (event.at >= rebuild.run.tick) insert(rebuild.queue, rebuild.next, event);
      else this.startRebuild(environment, seed, log, run.tick);
      return;
    }
    if (event.at < run.tick) {
      this.startRebuild(environment, seed, log, run.tick);
      return;
    }
    insert(this.pending, 0, event);
    this.applyDue(run);
    if ('patches' in event && event.at <= run.tick) useStore.getState().bumpStructure();
    this.publish();
  }

  /** Brings a screen that fell behind (a hidden tab, a slow laptop) to where the session is, rebuilding in the background. */
  catchUp(environment: Environment, seed: number, events: TimedEvent[], tick: number) {
    if (!this.run) return;
    this.startRebuild(environment, seed, events, tick);
  }

  /** Whether a live session's run is being rebuilt in the background. */
  catchingUp() {
    return this.rebuilding !== null;
  }

  // Applies queued session actions whose tick this run has reached, before its next step, as evaluate() orders them.
  private applyDue(run: Run) {
    let applied = false;
    while (this.pending.length && this.pending[0].at <= run.tick) {
      play(run, this.pending.shift()!);
      applied = true;
    }
    return applied;
  }

  private startRebuild(environment: Environment, seed: number, events: TimedEvent[], target: number) {
    const domain = DOMAINS[environment.domain];
    // Never aim past the replay limit: a screen sent further than it can replay would stay behind and catch up again for ever.
    this.rebuilding = {
      environment,
      seed,
      run: domain.createRun(domain.compile(environment.spec), seed),
      queue: [...events].sort(byTick),
      next: 0,
      target: Math.min(MAX_SHARED_TICKS, target),
    };
    // The rebuild replays the whole log, so actions waiting for this screen's clock are already in it.
    this.pending = [];
  }

  // Steps the rebuilt run for at most "budget" ms, then swaps it in once it reaches the live run, which kept playing meanwhile.
  private advanceRebuild(budget: number) {
    const job = this.rebuilding;
    const live = this.run;
    if (!job || !live) return;
    const until = performance.now() + budget;
    const goal = () => Math.min(MAX_SHARED_TICKS, Math.max(job.target, live.tick));
    for (;;) {
      while (job.next < job.queue.length && job.queue[job.next].at <= job.run.tick) play(job.run, job.queue[job.next++]);
      if (job.run.tick >= goal() || performance.now() >= until) break;
      job.run.step();
    }
    if (job.run.tick < goal()) return;
    this.rebuilding = null;
    this.run = job.run;
    // Actions stamped after where the rebuild stopped wait for the clock like any other.
    this.pending = job.queue.slice(job.next);
    if (job.queue.some((e) => 'patches' in e)) useStore.getState().bumpStructure();
    this.publish();
  }

  history() {
    const { run } = this;
    if (!run) return null;
    return { seed: this.seed, tick: run.tick, events: [...run.log] };
  }
}

export const runner = new Runner();

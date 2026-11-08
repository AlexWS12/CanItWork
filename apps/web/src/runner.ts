import { DOMAINS, type Domain, type Environment, type Incident, type Run, type TimedEvent } from '@tv/core';
import { MAX_SHARED_TICKS } from './share';
import { useStore } from './store';

const PUBLISH_EVERY = 0.2;
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
  /** Hears every action taken on this screen and every play, pause or speed change, so a live session can share them. */
  onLocal: ((event: TimedEvent) => void) | null = null;
  onTransport: ((running: boolean, speed: number, tick: number) => void) | null = null;

  load(environment: Environment, seed = 1) {
    const domain = DOMAINS[environment.domain];
    this.domain = domain;
    this.run = domain.createRun(domain.compile(environment.spec), seed);
    this.seed = seed;
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
    const { run, domain } = this;
    if (!run || !domain) return;
    if (this.running) {
      const stepTime = 1 / (domain.ticksPerSecond * this.speed);
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= stepTime) {
        if (run.tick >= MAX_SHARED_TICKS) {
          this.stopAtLimit();
          break;
        }
        run.step();
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
    run.step();
    this.publish();
    if (logged) this.onLocal?.(logged);
    return true;
  }

  applyPatches(patches: unknown[]) {
    if (!this.run || !patches.length) return;
    this.run.apply(patches);
    const logged = this.run.log.at(-1);
    useStore.getState().bumpStructure();
    this.publish();
    if (logged) this.onLocal?.(logged);
  }

  /** Brings in actions from a live session: replays the whole log to where this screen already is, so every screen agrees. */
  catchUp(environment: Environment, seed: number, events: TimedEvent[], tick: number) {
    const { running, speed } = this;
    // Never aim past the replay limit: a screen sent further than it can replay would stay behind and catch up again for ever.
    this.replay(environment, seed, Math.min(MAX_SHARED_TICKS, Math.max(tick, this.run?.tick ?? 0)), events);
    this.running = running;
    this.speed = speed;
    this.publish();
  }

  history() {
    const { run } = this;
    if (!run) return null;
    return { seed: this.seed, tick: run.tick, events: [...run.log] };
  }
}

export const runner = new Runner();

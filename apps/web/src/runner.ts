import { DOMAINS, type Domain, type Environment, type Incident, type Run } from '@tv/core';
import { useStore } from './store';

const PUBLISH_EVERY = 0.2;

class Runner {
  run: Run | null = null;
  domain: Domain | null = null;
  seed = 1;
  running = false;
  speed = 1;
  alpha = 0;
  private acc = 0;
  private sincePublish = 0;

  load(environment: Environment, seed = 1) {
    const domain = DOMAINS[environment.domain];
    this.domain = domain;
    this.run = domain.createRun(domain.compile(environment.spec), seed);
    this.seed = seed;
    this.acc = 0;
    this.alpha = 0;
    this.running = true;
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
        run.step();
        this.acc -= stepTime;
      }
      this.alpha = this.acc / stepTime;
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
    useStore.getState().setTelemetry({
      tick: run.tick,
      stats: run.telemetry(),
      breakables: run.breakables(),
      running: this.running,
      speed: this.speed,
      history: run.evaluation().series.slice(-60).map((p) => p.value),
    });
  }

  toggle() {
    this.running = !this.running;
    this.publish();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.publish();
  }

  inject(incident: Incident) {
    const { run } = this;
    if (!run) return false;
    run.inject(incident);
    run.step();
    this.publish();
    return true;
  }

  applyPatches(patches: unknown[]) {
    if (!this.run || !patches.length) return;
    this.run.apply(patches);
    useStore.getState().bumpStructure();
    this.publish();
  }

  history() {
    const { run } = this;
    if (!run) return null;
    return { seed: this.seed, tick: run.tick, events: [...run.log] };
  }
}

export const runner = new Runner();

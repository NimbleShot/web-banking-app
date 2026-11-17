import type { Clock } from '../../src/clock';

/** A clock that stands still until a test moves it. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(start = new Date('2026-01-01T09:00:00.000Z')) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

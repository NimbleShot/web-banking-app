// The time every rule reads (docs/decisions/0009): injected, so tests move it by hand.

export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

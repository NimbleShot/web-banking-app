// The transfer the dashboard should count, once. It lives in memory rather than in the history
// entry, so a reload or the Back button can never replay the animation.
let sentId: string | null = null;
const listeners = new Set<() => void>();

/** Remembers a sent transfer, and tells a dashboard already on screen to load it. */
export function rememberSent(id: string): void {
  sentId = id;
  listeners.forEach((listener) => listener());
}

export function takeSent(): string | null {
  const id = sentId;
  sentId = null;
  return id;
}

/** At sign-out and sign-in, so the next person in this tab never sees it as theirs. */
export function forgetSent(): void {
  sentId = null;
}

export function onSent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

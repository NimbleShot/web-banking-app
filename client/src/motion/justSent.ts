// The transfer the dashboard should count, once. It lives in memory rather than in the history
// entry, so a reload or the Back button can never replay the animation.
let sentId: string | null = null;

export function rememberSent(id: string): void {
  sentId = id;
}

export function takeSent(): string | null {
  const id = sentId;
  sentId = null;
  return id;
}

// The large notices the login page can open with, chosen by the screen that sends the user there.
export const NOTICES = {
  signedOut: {
    title: "You've signed out",
    body: 'Sign in again to get back to your account.',
  },
  passwordChanged: {
    title: 'Password reset successful',
    body: 'Sign in with your new password. The old one no longer works.',
  },
} as const;

export type NoticeKind = keyof typeof NOTICES;

/** The router state that asks the login page to show a notice. */
export function loginState(notice: NoticeKind): { notice: NoticeKind } {
  return { notice };
}

/** History state outlives the code that wrote it, so an unknown value simply shows nothing. */
export function noticeFrom(state: unknown): (typeof NOTICES)[NoticeKind] | null {
  if (typeof state !== 'object' || state === null || !('notice' in state)) return null;
  const { notice } = state;
  return typeof notice === 'string' && Object.hasOwn(NOTICES, notice)
    ? NOTICES[notice as NoticeKind]
    : null;
}

import { MAX_TRIES, RESEND_COOLDOWN_MS } from '../forms/passcode';

export type SignUpDetails = {
  email: string;
  /** In E.164, as the API takes it. */
  phone: string;
  /** As the user typed it, to refill the form on "Go back". */
  phoneText: string;
  password: string;
};

export type SignUpDraft = SignUpDetails & { triesLeft: number; resendAt: number };

// The server saves the password and phone only when they arrive with the right passcode, so the
// client holds them between the two screens. In this variable only, never in browser storage:
// a reload loses them on purpose and the user signs up again.
let draft: SignUpDraft | null = null;

export function getSignUpDraft(): SignUpDraft | null {
  return draft;
}

/**
 * The draft after a sign-up was accepted. Inside the cooldown the server sends nothing and the
 * same code stays live, so the same email keeps its tries and countdown.
 */
export function nextDraft(
  previous: SignUpDraft | null,
  details: SignUpDetails,
  now: number,
): SignUpDraft {
  const sameCode =
    previous !== null &&
    previous.email.toLowerCase() === details.email.toLowerCase() &&
    now < previous.resendAt;
  return {
    ...details,
    triesLeft: sameCode ? previous.triesLeft : MAX_TRIES,
    resendAt: sameCode ? previous.resendAt : now + RESEND_COOLDOWN_MS,
  };
}

export function saveSignUpDraft(details: SignUpDetails, now: number): void {
  draft = nextDraft(draft, details, now);
}

export function updateSignUpDraft(change: Pick<SignUpDraft, 'triesLeft'> & Partial<SignUpDraft>) {
  if (draft) draft = { ...draft, ...change };
}

export function clearSignUpDraft(): void {
  draft = null;
}

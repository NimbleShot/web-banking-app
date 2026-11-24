import { nextDraft, type CodeProgress } from './codeProgress';

export type SignUpDetails = {
  email: string;
  /** In E.164, as the API takes it. */
  phone: string;
  /** As the user typed it, to refill the form on "Go back". */
  phoneText: string;
  password: string;
};

export type SignUpDraft = SignUpDetails & CodeProgress;

// The server saves the password and phone only when they arrive with the right passcode, so the
// client holds them between the two screens. In this variable only, never in browser storage:
// a reload loses them on purpose and the user signs up again.
let draft: SignUpDraft | null = null;

export function getSignUpDraft(): SignUpDraft | null {
  return draft;
}

export function saveSignUpDraft(details: SignUpDetails, now: number): void {
  draft = nextDraft(draft, details, now);
}

export function updateSignUpDraft(change: Partial<CodeProgress>): void {
  if (draft) draft = { ...draft, ...change };
}

export function clearSignUpDraft(): void {
  draft = null;
}

import { nextDraft, type CodeProgress } from './codeProgress';

export type ResetDraft = { email: string } & CodeProgress;

// Carries the email and the code's progress from the forgot screen to the reset screen.
let draft: ResetDraft | null = null;

export function getResetDraft(): ResetDraft | null {
  return draft;
}

export function saveResetDraft(email: string, now: number): void {
  draft = nextDraft(draft, { email }, now);
}

export function updateResetDraft(change: Partial<CodeProgress>): void {
  if (draft) draft = { ...draft, ...change };
}

export function clearResetDraft(): void {
  draft = null;
}

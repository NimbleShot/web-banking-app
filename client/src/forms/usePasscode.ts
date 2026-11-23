import { useEffect, useState, type RefObject } from 'react';
import { failureMessage, type Result } from '../api/client';
import type { CodeProgress } from '../auth/codeProgress';
import { countdownText, MAX_TRIES, RESEND_COOLDOWN_MS } from './passcode';
import { useCountdown } from './useCountdown';

type Options = {
  progress: CodeProgress;
  saveProgress: (change: Partial<CodeProgress>) => void;
  sendNewCode: () => Promise<Result<unknown>>;
  /** The code field and the locked state's button, which this hook moves the focus to. */
  inputRef: RefObject<HTMLInputElement | null>;
  lockButtonRef: RefObject<HTMLButtonElement | null>;
};

/** What both code screens share: the code, the tries left, the lock and the new-code countdown. */
export function usePasscode({
  progress,
  saveProgress,
  sendNewCode,
  inputRef,
  lockButtonRef,
}: Options) {
  const [code, setCode] = useState('');
  const [rejected, setRejected] = useState(false);
  const [triesLeft, setTriesLeft] = useState(progress.triesLeft);
  const [resendAt, setResendAt] = useState(progress.resendAt);
  const [problem, setProblem] = useState<string | null>(null);
  const [newCodeSent, setNewCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const waitMs = useCountdown(resendAt);
  const locked = triesLeft === 0;

  // Runs after the field is enabled again, which a direct focus() call would come too early for.
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest, inputRef]);

  useEffect(() => {
    if (locked) lockButtonRef.current?.focus();
  }, [locked, lockButtonRef]);

  function changeCode(digits: string) {
    setCode(digits);
    setRejected(false);
  }

  /** Sends the code. A rejected one costs a try; any other failure shows its message. */
  async function submit<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
    setBusy(true);
    setProblem(null);
    setNewCodeSent(false);
    const result = await call();
    setBusy(false);

    if (!result.ok) {
      if (result.failure.kind === 'problem' && result.failure.code === 'PASSCODE_INVALID') {
        const left = Math.max(0, triesLeft - 1);
        setTriesLeft(left);
        saveProgress({ triesLeft: left });
        setRejected(true);
        if (left > 0) {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      } else {
        setProblem(failureMessage(result.failure));
      }
    }
    return result;
  }

  async function resend() {
    if (waitMs > 0 || busy) return;
    setBusy(true);
    setProblem(null);
    setNewCodeSent(false);
    const result = await sendNewCode();
    setBusy(false);

    if (!result.ok) {
      setProblem(failureMessage(result.failure));
      return;
    }
    const nextResendAt = Date.now() + RESEND_COOLDOWN_MS;
    setResendAt(nextResendAt);
    setTriesLeft(MAX_TRIES);
    saveProgress({ triesLeft: MAX_TRIES, resendAt: nextResendAt });
    setCode('');
    setRejected(false);
    setNewCodeSent(true);
    setFocusRequest((request) => request + 1);
  }

  return {
    code,
    changeCode,
    rejected,
    triesLeft,
    locked,
    busy,
    problem,
    newCodeSent,
    canResend: waitMs === 0 && !busy,
    resendLabel: waitMs > 0 ? `Send a new code in ${countdownText(waitMs)}` : 'Send a new code',
    showTries: triesLeft < MAX_TRIES,
    submit,
    resend,
  };
}

export type PasscodeFlow = ReturnType<typeof usePasscode>;

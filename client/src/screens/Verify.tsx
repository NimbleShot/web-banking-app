import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, attempt, failureMessage } from '../api/client';
import { saveToken } from '../auth/session';
import {
  clearSignUpDraft,
  getSignUpDraft,
  updateSignUpDraft,
  type SignUpDraft,
} from '../auth/signUpDraft';
import { FormAlert, TriesAlert } from '../components/Alerts';
import { CodeField } from '../components/CodeField';
import { GlassCard } from '../components/GlassCard';
import { ArrowIcon, RefreshIcon } from '../components/icons';
import { Page } from '../components/Page';
import { StepHeading } from '../components/StepHeading';
import { CODE_LENGTH, countdownText, MAX_TRIES, RESEND_COOLDOWN_MS } from '../forms/passcode';
import { useCountdown } from '../forms/useCountdown';

const ALERT_ID = 'verify-alert';

export function Verify() {
  const [draft] = useState(getSignUpDraft);
  // A reload clears the in-memory form values, and this screen can't work without them.
  if (!draft) return <Navigate to="/signup" replace />;
  return <VerifyForm draft={draft} />;
}

function VerifyForm({ draft }: { draft: SignUpDraft }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [codeRejected, setCodeRejected] = useState(false);
  const [triesLeft, setTriesLeft] = useState(draft.triesLeft);
  const [resendAt, setResendAt] = useState(draft.resendAt);
  const [problem, setProblem] = useState<string | null>(null);
  const [newCodeSent, setNewCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const waitMs = useCountdown(resendAt);
  const locked = triesLeft === 0;
  const canResend = waitMs === 0 && !busy;

  // Runs after the field is enabled again, which a direct focus() call would come too early for.
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);

  async function verify(event: SyntheticEvent) {
    event.preventDefault();
    if (busy || locked || code.length !== CODE_LENGTH) return;
    setBusy(true);
    setProblem(null);
    setNewCodeSent(false);

    const result = await attempt(() =>
      api.POST('/api/v1/auth/otp/verify', {
        body: { email: draft.email, passcode: code, password: draft.password, phone: draft.phone },
      }),
    );
    setBusy(false);

    if (result.ok) {
      saveToken(result.data.accessToken);
      clearSignUpDraft();
      void navigate('/dashboard', { replace: true });
      return;
    }
    if (result.failure.kind === 'problem' && result.failure.code === 'PASSCODE_INVALID') {
      const left = Math.max(0, triesLeft - 1);
      setTriesLeft(left);
      updateSignUpDraft({ triesLeft: left });
      setCodeRejected(true);
      inputRef.current?.select();
      return;
    }
    setProblem(failureMessage(result.failure));
  }

  async function resend() {
    if (!canResend) return;
    setBusy(true);
    setProblem(null);
    setNewCodeSent(false);
    const result = await attempt(() =>
      api.POST('/api/v1/auth/otp/resend', { body: { email: draft.email } }),
    );
    setBusy(false);

    if (!result.ok) {
      setProblem(failureMessage(result.failure));
      return;
    }
    const nextResendAt = Date.now() + RESEND_COOLDOWN_MS;
    setResendAt(nextResendAt);
    setTriesLeft(MAX_TRIES);
    updateSignUpDraft({ triesLeft: MAX_TRIES, resendAt: nextResendAt });
    setCode('');
    setCodeRejected(false);
    setNewCodeSent(true);
    setFocusRequest((request) => request + 1);
  }

  const resendLabel =
    waitMs > 0 ? `Send a new code in ${countdownText(waitMs)}` : 'Send a new code';

  return (
    <Page title="Check your email" label="EMAIL CHECK">
      <GlassCard>
        <StepHeading step={2} />
        <h1 className="card-title">Check your email</h1>
        <p className="card-lead card-lead-tight">
          We sent a 6-digit code to <strong className="card-strong">{draft.email}</strong>. It works
          for 10 minutes.
        </p>
        {triesLeft < MAX_TRIES && <TriesAlert id={ALERT_ID} triesLeft={triesLeft} />}
        {problem && <FormAlert title={problem} />}
        {newCodeSent && (
          <p className="form-status" role="status">
            We sent a new code.
          </p>
        )}

        <form className="form form-code" onSubmit={(event) => void verify(event)} noValidate>
          <CodeField
            legend="Verification code"
            inputLabel="6-digit verification code"
            value={code}
            invalid={codeRejected}
            locked={locked}
            describedBy={triesLeft < MAX_TRIES ? ALERT_ID : undefined}
            inputRef={inputRef}
            onChange={(digits) => {
              setCode(digits);
              setCodeRejected(false);
            }}
          />
          {locked ? (
            <button
              type="button"
              className="button-primary"
              disabled={!canResend}
              onClick={() => void resend()}
            >
              <RefreshIcon />
              {resendLabel}
            </button>
          ) : (
            <button
              type="submit"
              className="button-primary"
              disabled={busy || code.length !== CODE_LENGTH}
            >
              {busy ? 'Checking…' : 'Verify and continue'}
              {!busy && <ArrowIcon />}
            </button>
          )}
        </form>

        {!locked && (
          <div className="resend-row">
            <span>Didn&apos;t get it?</span>
            <button
              type="button"
              className="link-button"
              disabled={!canResend}
              onClick={() => void resend()}
            >
              {resendLabel}
            </button>
          </div>
        )}

        <div className="divider" />
        <p className="card-foot">
          Wrong email? <Link to="/signup">Go back</Link>
        </p>
      </GlassCard>
    </Page>
  );
}

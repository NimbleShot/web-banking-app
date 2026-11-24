import { useRef, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, attempt } from '../api/client';
import { saveToken } from '../auth/session';
import {
  clearSignUpDraft,
  getSignUpDraft,
  updateSignUpDraft,
  type SignUpDraft,
} from '../auth/signUpDraft';
import { CodeField } from '../components/CodeField';
import { ArrowIcon } from '../components/icons';
import { PageTitle } from '../components/Page';
import { NewCodeButton, PasscodeAlerts, ResendRow } from '../components/PasscodeParts';
import { StepHeading } from '../components/StepHeading';
import { CODE_LENGTH } from '../forms/passcode';
import { usePasscode } from '../forms/usePasscode';
import { useOnScreen } from '../useOnScreen';

const ALERT_ID = 'verify-alert';

export function Verify() {
  const [draft] = useState(getSignUpDraft);
  // A reload clears the in-memory form values, and this screen can't work without them.
  if (!draft) return <Navigate to="/signup" replace />;
  return <VerifyForm draft={draft} />;
}

function VerifyForm({ draft }: { draft: SignUpDraft }) {
  const navigate = useNavigate();
  const onScreen = useOnScreen();
  const inputRef = useRef<HTMLInputElement>(null);
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const flow = usePasscode({
    alertId: ALERT_ID,
    inputRef,
    lockButtonRef,
    progress: draft,
    saveProgress: updateSignUpDraft,
    sendNewCode: () =>
      attempt(() => api.POST('/api/v1/auth/otp/resend', { body: { email: draft.email } })),
  });

  async function verify(event: SyntheticEvent) {
    event.preventDefault();
    if (flow.busy || flow.locked || flow.code.length !== CODE_LENGTH) return;

    const result = await flow.submit(() =>
      attempt(() =>
        api.POST('/api/v1/auth/otp/verify', {
          body: {
            email: draft.email,
            passcode: flow.code,
            password: draft.password,
            phone: draft.phone,
          },
        }),
      ),
    );
    if (result.ok) {
      // The account exists either way. Only a user still on this screen is signed in to it.
      clearSignUpDraft();
      if (!onScreen.current) return;
      saveToken(result.data.accessToken);
      void navigate('/dashboard', { replace: true });
    }
  }

  return (
    <>
      <PageTitle title="Check your email" />
      <StepHeading step={2} />
      <h1 className="card-title">Check your email</h1>
      <p className="card-lead card-lead-code">
        We sent a 6-digit code to <strong className="card-strong">{draft.email}</strong>. It works
        for 10 minutes.
      </p>
      <PasscodeAlerts flow={flow} alertId={ALERT_ID} />

      <form className="form form-code" onSubmit={(event) => void verify(event)} noValidate>
        <CodeField
          legend="Verification code"
          inputLabel="6-digit verification code"
          value={flow.code}
          invalid={flow.rejected}
          locked={flow.locked}
          describedBy={flow.showTries ? ALERT_ID : undefined}
          inputRef={inputRef}
          onChange={flow.changeCode}
        />
        {flow.locked ? (
          <NewCodeButton flow={flow} buttonRef={lockButtonRef} />
        ) : (
          <button
            type="submit"
            className="button-primary"
            disabled={flow.busy || flow.code.length !== CODE_LENGTH}
          >
            {flow.busy ? 'Checking…' : 'Verify and continue'}
            {!flow.busy && <ArrowIcon />}
          </button>
        )}
      </form>
      <ResendRow flow={flow} />

      <div className="divider divider-code" />
      <p className="card-foot">
        Wrong email? <Link to="/signup">Go back</Link>
      </p>
    </>
  );
}

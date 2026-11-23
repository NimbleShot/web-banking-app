import { useRef, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, attempt } from '../api/client';
import { loginState } from '../auth/notices';
import {
  clearResetDraft,
  getResetDraft,
  updateResetDraft,
  type ResetDraft,
} from '../auth/resetDraft';
import { CodeField } from '../components/CodeField';
import { Field, Input, PasswordInput } from '../components/Field';
import { ArrowIcon } from '../components/icons';
import { PageTitle } from '../components/Page';
import { NewCodeButton, PasscodeAlerts, ResendRow } from '../components/PasscodeParts';
import { StepHeading } from '../components/StepHeading';
import { CODE_LENGTH } from '../forms/passcode';
import { checkPassword } from '../forms/rules';
import { usePasscode } from '../forms/usePasscode';

const ALERT_ID = 'reset-alert';
const PASSWORD_ID = 'reset-password';
const RETYPE_ID = 'reset-password2';

export function Reset() {
  const [draft] = useState(getResetDraft);
  if (!draft) return <Navigate to="/forgot" replace />;
  return <ResetForm draft={draft} />;
}

function ResetForm({ draft }: { draft: ResetDraft }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const flow = usePasscode({
    inputRef,
    lockButtonRef,
    progress: draft,
    saveProgress: updateResetDraft,
    sendNewCode: () =>
      attempt(() => api.POST('/api/v1/auth/password/forgot', { body: { email: draft.email } })),
  });
  const [password, setPassword] = useState('');
  const [retype, setRetype] = useState('');
  const [shown, setShown] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [retypeError, setRetypeError] = useState<string | null>(null);
  const retypeOk = !retypeError && password.length > 0 && password === retype;

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (flow.busy || flow.locked || flow.code.length !== CODE_LENGTH) return;

    // Checked here, before any request, so a password mistake never costs a try.
    const passwordCheck = checkPassword(password);
    const retypeProblem = !retype
      ? 'Retype your new password.'
      : retype !== password
        ? "The passwords don't match."
        : null;
    if (!passwordCheck.ok || retypeProblem) {
      setPasswordError(passwordCheck.ok ? null : passwordCheck.message);
      setRetypeError(retypeProblem);
      document.getElementById(passwordCheck.ok ? RETYPE_ID : PASSWORD_ID)?.focus();
      return;
    }

    const result = await flow.submit(() =>
      attempt(() =>
        api.POST('/api/v1/auth/password/reset', {
          body: { email: draft.email, passcode: flow.code, password },
        }),
      ),
    );
    if (result.ok) {
      clearResetDraft();
      void navigate('/login', { replace: true, state: loginState('passwordChanged') });
    }
  }

  return (
    <>
      <PageTitle title="Set a new password" />
      <StepHeading step={2} />
      <h1 className="card-title">Set a new password</h1>
      <p className="card-lead card-lead-code card-lead-reset">
        If an account uses <strong className="card-strong">{draft.email}</strong>, we sent it a
        6-digit code. It works for 10 minutes.
      </p>
      <PasscodeAlerts flow={flow} alertId={ALERT_ID} />

      <form className="form form-reset" onSubmit={(event) => void submit(event)} noValidate>
        <CodeField
          legend="Reset code"
          inputLabel="6-digit reset code"
          value={flow.code}
          invalid={flow.rejected}
          locked={flow.locked}
          describedBy={flow.showTries ? ALERT_ID : undefined}
          inputRef={inputRef}
          onChange={flow.changeCode}
        />

        <Field
          id={PASSWORD_ID}
          label="New password"
          hint="8 to 72 characters."
          error={passwordError}
          plainError
        >
          <PasswordInput
            id={PASSWORD_ID}
            autoComplete="new-password"
            placeholder="Choose a new password"
            value={password}
            invalid={Boolean(passwordError)}
            described
            shown={shown}
            onToggle={() => setShown(!shown)}
            noun="passwords"
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError(null);
              setRetypeError(null);
            }}
          />
        </Field>

        <Field
          id={RETYPE_ID}
          label="Retype new password"
          error={retypeError}
          ok={retypeOk ? 'Passwords match.' : undefined}
          plainError
        >
          <Input
            id={RETYPE_ID}
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="Type it again"
            value={retype}
            invalid={Boolean(retypeError)}
            described={Boolean(retypeError) || retypeOk}
            onChange={(event) => {
              setRetype(event.target.value);
              setRetypeError(null);
            }}
          />
        </Field>

        {flow.locked ? (
          <NewCodeButton flow={flow} buttonRef={lockButtonRef} />
        ) : (
          <button
            type="submit"
            className="button-primary"
            disabled={flow.busy || flow.code.length !== CODE_LENGTH}
          >
            {flow.busy ? 'Saving…' : 'Set new password'}
            {!flow.busy && <ArrowIcon />}
          </button>
        )}
      </form>
      <ResendRow flow={flow} />

      <div className="divider divider-code" />
      <p className="card-foot">
        Wrong email? <Link to="/forgot">Go back</Link>
      </p>
    </>
  );
}

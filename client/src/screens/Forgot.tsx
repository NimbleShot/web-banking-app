import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, attempt, failureMessage } from '../api/client';
import { isSameCode } from '../auth/codeProgress';
import { getResetDraft, saveResetDraft } from '../auth/resetDraft';
import { FormAlert } from '../components/Alerts';
import { Field, Input } from '../components/Field';
import { ArrowIcon } from '../components/icons';
import { PageTitle } from '../components/Page';
import { StepHeading } from '../components/StepHeading';
import { checkEmail } from '../forms/rules';

const EMAIL_ID = 'forgot-email';

export function Forgot() {
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => getResetDraft()?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function showError(message: string) {
    setError(message);
    document.getElementById(EMAIL_ID)?.focus();
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(null);

    const check = checkEmail(email.trim());
    if (!check.ok) {
      showError(check.message);
      return;
    }
    setError(null);
    setEmail(check.value);

    // The same email inside the cooldown would send nothing: its code is still the live one.
    if (!isSameCode(getResetDraft(), check.value, Date.now())) {
      setBusy(true);
      const result = await attempt(() =>
        api.POST('/api/v1/auth/password/forgot', { body: { email: check.value } }),
      );
      setBusy(false);

      if (!result.ok) {
        const { failure } = result;
        if (failure.kind === 'problem' && failure.fields.email) showError(failure.fields.email);
        else setProblem(failureMessage(failure));
        return;
      }
    }
    saveResetDraft(check.value, Date.now());
    void navigate('/reset');
  }

  return (
    <>
      <PageTitle title="Forgot your password?" />
      <StepHeading step={1} />
      <h1 className="card-title">Forgot your password?</h1>
      <p className="card-lead card-lead-code">
        Enter your account&apos;s email. If it&apos;s registered, we&apos;ll send a 6-digit code to
        reset your password.
      </p>
      {problem && <FormAlert title={problem} />}

      <form className="form form-code" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={EMAIL_ID} label="Email" error={error} plainError>
          <Input
            id={EMAIL_ID}
            type="text"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            invalid={Boolean(error)}
            described={Boolean(error)}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send code'}
          {!busy && <ArrowIcon />}
        </button>
      </form>

      <div className="divider divider-login" />
      <p className="card-foot">
        Remembered it? <Link to="/login">Back to sign in</Link>
      </p>
    </>
  );
}

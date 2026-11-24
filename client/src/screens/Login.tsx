import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { api, attempt, failureMessage } from '../api/client';
import { clearResetDraft } from '../auth/resetDraft';
import { saveToken } from '../auth/session';
import { clearSignUpDraft } from '../auth/signUpDraft';
import { FormAlert } from '../components/Alerts';
import { Field, Input, PasswordInput } from '../components/Field';
import { ArrowIcon } from '../components/icons';
import { PageTitle } from '../components/Page';
import type { FrameContext } from '../components/SignedOutFrame';
import { checkEmail, EMAIL_MESSAGE } from '../forms/rules';
import { forgetSent } from '../motion/justSent';
import { useOnScreen } from '../useOnScreen';

const EMAIL_ID = 'login-email';
const PASSWORD_ID = 'login-password';
const ALERT_ID = 'login-error';

type Errors = { email?: string | undefined; password?: string | undefined };

export function Login() {
  const navigate = useNavigate();
  const onScreen = useOnScreen();
  const { dismissNotice } = useOutletContext<FrameContext>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [rejected, setRejected] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(null);
    setRejected(false);
    dismissNotice();

    const emailCheck = checkEmail(email);
    if (!emailCheck.ok || password === '') {
      setErrors({
        email: emailCheck.ok ? undefined : emailCheck.message,
        password: password === '' ? 'Enter your password.' : undefined,
      });
      document.getElementById(emailCheck.ok ? PASSWORD_ID : EMAIL_ID)?.focus();
      return;
    }
    setErrors({});

    setBusy(true);
    const result = await attempt(() =>
      api.POST('/api/v1/auth/login', { body: { email: emailCheck.value, password } }),
    );
    setBusy(false);

    if (result.ok) {
      // The user went elsewhere while it was on its way: they stay where they are, signed out.
      if (!onScreen.current) return;
      saveToken(result.data.accessToken);
      clearSignUpDraft();
      clearResetDraft();
      forgetSent();
      void navigate('/dashboard', { replace: true });
      return;
    }

    const { failure } = result;
    if (failure.kind === 'problem') {
      // A password too long to be anyone's gets the same answer as a wrong one.
      const tooLong = failure.code === 'VALIDATION_FAILED' && failure.fields.password;
      if (failure.code === 'INVALID_CREDENTIALS' || tooLong) {
        setRejected(true);
        const field = document.getElementById(PASSWORD_ID) as HTMLInputElement | null;
        field?.focus();
        field?.select();
        return;
      }
      if (failure.code === 'VALIDATION_FAILED' && failure.fields.email) {
        setErrors({ email: EMAIL_MESSAGE });
        document.getElementById(EMAIL_ID)?.focus();
        return;
      }
    }
    setProblem(failureMessage(failure));
  }

  return (
    <>
      <PageTitle title="Sign in" />
      <span className="card-eyebrow">{'ACCESS // 01'}</span>
      <h2 className="card-title">Sign in</h2>
      <p className={`card-lead ${rejected || problem ? 'card-lead-tight' : ''}`}>
        Use the email and password you signed up with.
      </p>
      {rejected && (
        <FormAlert
          id={ALERT_ID}
          title="The email or password is incorrect."
          body={
            <>
              Check both and try again, or{' '}
              <Link to="/forgot" className="alert-link">
                reset your password
              </Link>
              .
            </>
          }
        />
      )}
      {problem && <FormAlert title={problem} />}

      <form className="form form-login" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={EMAIL_ID} label="Email" error={errors.email}>
          <Input
            id={EMAIL_ID}
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            value={email}
            invalid={rejected || Boolean(errors.email)}
            described={Boolean(errors.email)}
            describedBy={rejected ? ALERT_ID : undefined}
            onChange={(event) => {
              setEmail(event.target.value);
              setRejected(false);
              setErrors((current) => ({ ...current, email: undefined }));
            }}
          />
        </Field>

        <Field
          id={PASSWORD_ID}
          label="Password"
          error={errors.password}
          aside={
            <Link to="/forgot" className="field-aside">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            id={PASSWORD_ID}
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            invalid={rejected || Boolean(errors.password)}
            described={Boolean(errors.password)}
            describedBy={rejected ? ALERT_ID : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setRejected(false);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
          />
        </Field>

        <button type="submit" className="button-primary form-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
          {!busy && <ArrowIcon />}
        </button>
      </form>

      <div className="divider divider-login" />
      <p className="card-foot">
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </>
  );
}

import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, attempt, failureMessage } from '../api/client';
import { clearSignUpDraft, getSignUpDraft, saveSignUpDraft } from '../auth/signUpDraft';
import { FormAlert } from '../components/Alerts';
import { Field, Input, PasswordInput } from '../components/Field';
import { GlassCard } from '../components/GlassCard';
import { ArrowIcon } from '../components/icons';
import { Page } from '../components/Page';
import { StepHeading } from '../components/StepHeading';
import { checkEmail, checkPassword, checkPhone } from '../forms/rules';

type FieldName = 'email' | 'phone' | 'password';
type Errors = Partial<Record<FieldName, ReactNode>>;

const FIELD_IDS: Record<FieldName, string> = {
  email: 'signup-email',
  phone: 'signup-phone',
  password: 'signup-password',
};

export function SignUp() {
  const navigate = useNavigate();
  const [saved] = useState(getSignUpDraft);
  const [email, setEmail] = useState(saved?.email ?? '');
  const [phone, setPhone] = useState(saved?.phoneText ?? '');
  const [password, setPassword] = useState(saved?.password ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function showErrors(found: Errors) {
    setErrors(found);
    const first = (['email', 'phone', 'password'] as const).find((name) => found[name]);
    if (first) document.getElementById(FIELD_IDS[first])?.focus();
  }

  function clearError(name: FieldName) {
    setErrors((current) => ({ ...current, [name]: undefined }));
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(null);

    const emailCheck = checkEmail(email);
    const phoneCheck = checkPhone(phone);
    const passwordCheck = checkPassword(password);
    if (!emailCheck.ok || !phoneCheck.ok || !passwordCheck.ok) {
      showErrors({
        email: emailCheck.ok ? undefined : emailCheck.message,
        phone: phoneCheck.ok ? undefined : phoneCheck.message,
        password: passwordCheck.ok ? undefined : passwordCheck.message,
      });
      return;
    }
    setErrors({});

    setBusy(true);
    const result = await attempt(() =>
      api.POST('/api/v1/auth/signup', {
        body: { email: emailCheck.value, phone: phoneCheck.value, password },
      }),
    );
    setBusy(false);

    if (result.ok) {
      saveSignUpDraft(
        { email: emailCheck.value, phone: phoneCheck.value, phoneText: phone, password },
        Date.now(),
      );
      void navigate('/verify');
      return;
    }

    const { failure } = result;
    if (failure.kind === 'problem' && failure.code === 'EMAIL_TAKEN') {
      showErrors({
        email: (
          <>
            This email already has an account.{' '}
            <Link to="/login" className="field-error-link" onClick={clearSignUpDraft}>
              Sign in instead
            </Link>
          </>
        ),
      });
      return;
    }
    if (failure.kind === 'problem' && failure.code === 'VALIDATION_FAILED') {
      const { email: emailError, phone: phoneError, password: passwordError } = failure.fields;
      if (emailError || phoneError || passwordError) {
        showErrors({ email: emailError, phone: phoneError, password: passwordError });
        return;
      }
    }
    setProblem(failureMessage(failure));
  }

  return (
    <Page title="Create your account" label="SECURE SIGN-UP">
      <GlassCard>
        <StepHeading step={1} />
        <h1 className="card-title">Create your account</h1>
        <p className="card-lead card-lead-tight">
          We&apos;ll email you a code to confirm it&apos;s really you.
        </p>
        {problem && <FormAlert title={problem} />}

        <form className="form" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            id={FIELD_IDS.email}
            label="Email"
            hint="Your 6-digit code goes here."
            error={errors.email}
          >
            <Input
              id={FIELD_IDS.email}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              invalid={Boolean(errors.email)}
              described
              onChange={(event) => {
                setEmail(event.target.value);
                clearError('email');
              }}
            />
          </Field>

          <Field id={FIELD_IDS.phone} label="Phone number" error={errors.phone}>
            <div className="phone-row">
              <span className="phone-prefix">
                <span className="sr-only">Israel, country code </span>+972
              </span>
              <Input
                id={FIELD_IDS.phone}
                type="tel"
                autoComplete="tel-national"
                placeholder="50 123 4567"
                value={phone}
                invalid={Boolean(errors.phone)}
                described={Boolean(errors.phone)}
                onChange={(event) => {
                  setPhone(event.target.value);
                  clearError('phone');
                }}
              />
            </div>
          </Field>

          <Field
            id={FIELD_IDS.password}
            label="Password"
            hint="8 to 72 characters."
            error={errors.password}
          >
            <PasswordInput
              id={FIELD_IDS.password}
              autoComplete="new-password"
              placeholder="Choose a password"
              value={password}
              invalid={Boolean(errors.password)}
              described
              onChange={(event) => {
                setPassword(event.target.value);
                clearError('password');
              }}
            />
          </Field>

          <button type="submit" className="button-primary form-submit" disabled={busy}>
            {busy ? 'Creating your account…' : 'Create account'}
            {!busy && <ArrowIcon />}
          </button>
        </form>

        <div className="divider" />
        <p className="card-foot">
          Already have an account?{' '}
          <Link to="/login" onClick={clearSignUpDraft}>
            Sign in
          </Link>
        </p>
      </GlassCard>
    </Page>
  );
}

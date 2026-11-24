import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { components } from '../../../api/generated/schema';
import { api, attempt, failureMessage, type Failure } from '../api/client';
import { authHeaders, readToken } from '../auth/session';
import { useSessionEnd } from '../auth/useSessionEnd';
import { FormAlert } from '../components/Alerts';
import { Field, Input } from '../components/Field';
import { GlassCard } from '../components/GlassCard';
import { ArrowIcon } from '../components/icons';
import { Page } from '../components/Page';
import { formatBalance } from '../format';
import { checkAmount } from '../forms/amount';
import { checkEmail, EMAIL_MESSAGE } from '../forms/rules';
import { rememberSent } from '../motion/justSent';
import { useOnScreen } from '../useOnScreen';

const TO_ID = 'transfer-to';
const AMOUNT_ID = 'transfer-amount';

type Errors = { to?: string | undefined; amount?: string | undefined };
type Problem = { title: string; body?: string };

/** No answer, or the server failed while working: the money may or may not have moved. */
function outcomeUnknown(failure: Failure): boolean {
  return failure.kind === 'network' || failure.status >= 500;
}

function fieldErrors(failure: Failure): Errors | null {
  if (failure.kind !== 'problem') return null;
  switch (failure.code) {
    case 'RECIPIENT_NOT_FOUND':
      return { to: 'No account uses this email. Check it and try again.' };
    case 'SELF_TRANSFER':
      return { to: "You can't send money to yourself." };
    case 'INSUFFICIENT_FUNDS':
      return { amount: "That's more than your balance." };
    case 'VALIDATION_FAILED': {
      const { toEmail, amount } = failure.fields;
      return toEmail || amount ? { to: toEmail ? EMAIL_MESSAGE : undefined, amount } : null;
    }
    default:
      return null;
  }
}

export function Transfer() {
  const navigate = useNavigate();
  const endIfExpired = useSessionEnd();
  const onScreen = useOnScreen();
  // Set before the request starts, so a double click can never send the money twice.
  const sending = useRef(false);
  const [account, setAccount] = useState<components['schemas']['Account'] | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = checkAmount(amount);

  useEffect(() => {
    let current = true;
    void attempt(() => api.GET('/api/v1/me', { headers: authHeaders() })).then((result) => {
      if (!current) return;
      if (result.ok) setAccount(result.data);
      else if (!endIfExpired(result.failure)) {
        setProblem({ title: failureMessage(result.failure) });
      }
    });
    return () => {
      current = false;
    };
  }, [endIfExpired]);

  function showErrors(found: Errors) {
    setErrors(found);
    document.getElementById(found.to ? TO_ID : AMOUNT_ID)?.focus();
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (sending.current) return;
    setProblem(null);

    const toCheck = checkEmail(to.trim());
    const amountCheck = checkAmount(amount);
    if (!toCheck.ok || !amountCheck.ok) {
      showErrors({
        to: toCheck.ok ? undefined : toCheck.message,
        amount: amountCheck.ok ? undefined : amountCheck.message,
      });
      return;
    }
    setErrors({});

    sending.current = true;
    setBusy(true);
    const sentAs = readToken();
    const result = await attempt(() =>
      api.POST('/api/v1/transfers', {
        headers: authHeaders(),
        body: { toEmail: toCheck.value, amount: amountCheck.agorot },
      }),
    );

    if (result.ok) {
      // A late answer for someone who has since signed out, or in as someone else, isn't theirs.
      if (readToken() !== sentAs) return;
      // The dashboard loads the balance and the new record from the server, and counts it. If the
      // user already went back to it, it reloads when it hears of the transfer.
      rememberSent(result.data.transaction.id);
      if (onScreen.current) void navigate('/dashboard', { replace: true });
      return;
    }
    const { failure } = result;
    if (endIfExpired(failure)) return;
    sending.current = false;
    setBusy(false);

    const found = fieldErrors(failure);
    if (found) showErrors(found);
    else if (outcomeUnknown(failure)) {
      setProblem({
        title: "We can't tell if this transfer went through.",
        body: 'Check your transactions before you send it again.',
      });
      // The money may have left, so the balance from before the transfer is no longer offered.
      setAccount(null);
      void attempt(() => api.GET('/api/v1/me', { headers: authHeaders() })).then((me) => {
        if (me.ok) setAccount(me.data);
      });
    } else setProblem({ title: failureMessage(failure) });
  }

  return (
    <Page title="Send money" signedIn userEmail={account?.email}>
      <GlassCard className="card-transfer">
        <span className="card-eyebrow">NEW TRANSFER</span>
        <h1 className="card-title">Send money</h1>
        <p className="card-lead card-lead-form">
          You have{' '}
          <strong className="card-strong">
            {account ? `${formatBalance(account.balance)} ₪` : '—'}
          </strong>{' '}
          available.
        </p>
        {problem && (
          <FormAlert title={problem.title} {...(problem.body && { body: problem.body })} />
        )}

        <form className="form" onSubmit={(event) => void submit(event)} noValidate>
          <Field id={TO_ID} label="Recipient's email" error={errors.to}>
            <Input
              id={TO_ID}
              type="email"
              autoComplete="off"
              autoFocus
              placeholder="name@example.com"
              value={to}
              invalid={Boolean(errors.to)}
              described={Boolean(errors.to)}
              onChange={(event) => {
                setTo(event.target.value);
                setErrors((current) => ({ ...current, to: undefined }));
              }}
            />
          </Field>

          <Field id={AMOUNT_ID} label="Amount" error={errors.amount}>
            <div className="input-wrap">
              <Input
                id={AMOUNT_ID}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className="input-amount"
                value={amount}
                invalid={Boolean(errors.amount)}
                described={Boolean(errors.amount)}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setErrors((current) => ({ ...current, amount: undefined }));
                }}
              />
              <span className="input-currency" aria-hidden="true">
                ₪
              </span>
            </div>
          </Field>

          <button type="submit" className="button-primary form-submit" disabled={busy}>
            {busy ? 'Sending…' : typed.ok ? `Send ${formatBalance(typed.agorot)} ₪` : 'Send money'}
            {!busy && <ArrowIcon />}
          </button>
        </form>

        <div className="divider divider-transfer" />
        <p className="card-foot">
          Changed your mind? <Link to="/dashboard">Back to your account</Link>
        </p>
      </GlassCard>
    </Page>
  );
}

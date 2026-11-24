import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { components } from '../../../api/generated/schema';
import { api, attempt, failureMessage, type Failure } from '../api/client';
import { authHeaders } from '../auth/session';
import { useSessionEnd } from '../auth/useSessionEnd';
import { FormAlert } from '../components/Alerts';
import { GlassCard } from '../components/GlassCard';
import { ArrowIcon } from '../components/icons';
import { Page } from '../components/Page';
import { TransactionList } from '../components/TransactionList';
import { formatBalance, formatRemaining } from '../format';
import { onSent, takeSent } from '../motion/justSent';
import { useBalanceCount } from '../motion/useBalanceCount';

const LIST_TITLE_ID = 'tx-title';
const RECENT_TRANSACTIONS = 20;

type Loaded = {
  account: components['schemas']['Account'] | null;
  items: components['schemas']['Transaction'][] | null;
  failures: Failure[];
  now: Date;
  /** The transfer just sent from the send-money screen, which the balance counts down. */
  sent: components['schemas']['Transaction'] | null;
};

async function loadDashboard(): Promise<Loaded> {
  const headers = authHeaders();
  const [me, list] = await Promise.all([
    attempt(() => api.GET('/api/v1/me', { headers })),
    attempt(() =>
      api.GET('/api/v1/transactions', {
        headers,
        params: { query: { limit: RECENT_TRANSACTIONS } },
      }),
    ),
  ]);
  return {
    account: me.ok ? me.data : null,
    items: list.ok ? list.data.items : null,
    failures: [...(me.ok ? [] : [me.failure]), ...(list.ok ? [] : [list.failure])],
    now: new Date(),
    sent: null,
  };
}

/** Each character in its own fixed width, so the number doesn't shake while it counts. */
function BalanceDigits({ text }: { text: string }) {
  return [...text].map((character, index) => (
    <span key={index} className={/\d/.test(character) ? 'balance-digit' : 'balance-mark'}>
      {character}
    </span>
  ));
}

export function Dashboard() {
  const endIfExpired = useSessionEnd();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loads, setLoads] = useState(0);

  // A transfer that lands after the user came back here reloads the balance, and counts it.
  useEffect(() => onSent(() => setLoads((count) => count + 1)), []);

  useEffect(() => {
    let current = true;
    void loadDashboard().then((result) => {
      if (!current) return;
      const sentId = takeSent();
      if (result.failures.some((failure) => endIfExpired(failure))) return;
      // Only money this user sent: the other side of a transfer has the same id.
      const sent =
        result.account && result.items?.find((item) => item.id === sentId && item.amount < 0);
      setLoaded({ ...result, sent: sent ?? null });
    });
    return () => {
      current = false;
    };
  }, [endIfExpired, loads]);

  const account = loaded?.account ?? null;
  const failure = loaded?.failures[0];
  const sent = loaded?.sent ?? null;
  const count = useBalanceCount(account?.balance ?? null, sent?.amount ?? null);
  const shownText = count.shown === null ? null : formatBalance(count.shown);
  const trueText = account ? formatBalance(account.balance) : null;
  const longNumber = Math.max(shownText?.length ?? 0, trueText?.length ?? 0) > 10;

  // The new row waits until the count has used the amount up, then opens into the list.
  const rowHeld = sent !== null && ['lead', 'show', 'count'].includes(count.phase);
  const listed = rowHeld ? loaded?.items?.filter((item) => item.id !== sent.id) : loaded?.items;

  return (
    <Page
      title="Your account"
      signedIn
      userEmail={account?.email}
      contentClassName="page-content-dashboard"
    >
      <div className="dashboard">
        {failure && <FormAlert title={failureMessage(failure)} />}

        <section className="balance" aria-labelledby="balance-label">
          <h1 id="balance-label" className="balance-label">
            YOUR BALANCE
          </h1>
          <div className={`balance-delta balance-delta-${count.phase}`} aria-hidden="true">
            {sent && count.phase !== 'done' && formatRemaining(sent.amount, count.remaining)}
          </div>
          <p className={`balance-amount ${longNumber ? 'balance-amount-long' : ''}`}>
            <span className="balance-aura" aria-hidden="true" />
            <span className={`balance-value balance-value-${count.phase}`} aria-hidden="true">
              {shownText ? <BalanceDigits text={shownText} /> : '—'}
              <span className="balance-currency">₪</span>
            </span>
            {trueText && <span className="sr-only">{trueText} ₪</span>}
          </p>
          <p className="sr-only" role="status">
            {sent &&
              trueText &&
              `Sent ${formatBalance(sent.amount)} ₪ to ${sent.counterpartyEmail}. Your balance is now ${trueText} ₪.`}
          </p>
          <Link to="/transfer" className="button-primary balance-send">
            Send money
            <ArrowIcon />
          </Link>
        </section>

        <GlassCard className="tx-card" labelledBy={LIST_TITLE_ID}>
          <h2 id={LIST_TITLE_ID} className="tx-title">
            Recent transactions
          </h2>
          {loaded?.items && listed ? (
            !(rowHeld && listed.length === 0) && (
              <TransactionList
                items={listed}
                now={loaded.now}
                labelledBy={LIST_TITLE_ID}
                arrivingId={count.phase === 'land' ? sent?.id : undefined}
              />
            )
          ) : (
            <p className="tx-status" role="status">
              {loaded ? "We couldn't load your transactions." : 'Loading your transactions…'}
            </p>
          )}
        </GlassCard>
      </div>
    </Page>
  );
}

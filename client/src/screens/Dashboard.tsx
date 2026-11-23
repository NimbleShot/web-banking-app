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
import { formatBalance } from '../format';

const LIST_TITLE_ID = 'tx-title';
const RECENT_TRANSACTIONS = 20;

type Loaded = {
  account: components['schemas']['Account'] | null;
  items: components['schemas']['Transaction'][] | null;
  failures: Failure[];
  now: Date;
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
  };
}

export function Dashboard() {
  const endIfExpired = useSessionEnd();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let current = true;
    void loadDashboard().then((result) => {
      if (!current || result.failures.some((failure) => endIfExpired(failure))) return;
      setLoaded(result);
    });
    return () => {
      current = false;
    };
  }, [endIfExpired]);

  const account = loaded?.account ?? null;
  const failure = loaded?.failures[0];

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
          <div className="balance-gap" aria-hidden="true" />
          <p className="balance-amount">
            <span className="balance-aura" aria-hidden="true" />
            <span className="balance-value">
              {account ? formatBalance(account.balance) : '—'}
              <span className="balance-currency">₪</span>
            </span>
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
          {loaded?.items ? (
            <TransactionList items={loaded.items} now={loaded.now} labelledBy={LIST_TITLE_ID} />
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

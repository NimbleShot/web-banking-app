import type { components } from '../../../api/generated/schema';
import { formatTransfer, formatWhen } from '../format';
import { ArrowDownLeftIcon, ArrowUpRightIcon } from './icons';

type Transaction = components['schemas']['Transaction'];

type TransactionListProps = {
  items: Transaction[];
  now: Date;
  /** The id of the heading that names the list. */
  labelledBy: string;
  /** A transaction that opens into the list as it appears. */
  arrivingId?: string | undefined;
};

export function TransactionList({ items, now, labelledBy, arrivingId }: TransactionListProps) {
  if (items.length === 0) {
    return (
      <div className="tx-empty">
        <p className="tx-empty-title">No transactions yet</p>
        <p className="tx-empty-body">Money you send or receive will show up here.</p>
      </div>
    );
  }

  return (
    // Focusable so that keyboard users can scroll the list inside its card.
    <ul className="tx-list" aria-labelledby={labelledBy} tabIndex={0}>
      {items.map((transaction) => {
        const sent = transaction.amount < 0;
        return (
          <li
            key={transaction.id}
            className={`tx-row ${sent ? 'tx-sent' : 'tx-received'} ${
              transaction.id === arrivingId ? 'tx-row-arriving' : ''
            }`}
          >
            <span className="tx-icon" aria-hidden="true">
              {sent ? <ArrowUpRightIcon /> : <ArrowDownLeftIcon />}
            </span>
            <span className="tx-main">
              <span className="tx-who">
                <span className="sr-only">{sent ? 'Sent to ' : 'Received from '}</span>
                {transaction.counterpartyEmail}
              </span>
              <span className="tx-when">{formatWhen(transaction.createdAt, now)}</span>
            </span>
            <span className="tx-amount">{formatTransfer(transaction.amount)}</span>
          </li>
        );
      })}
    </ul>
  );
}

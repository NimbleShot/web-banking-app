import { BANK_NAME } from '../brand';

export function Header({ label }: { label?: string | undefined }) {
  return (
    <header className="site-header">
      <div className="brand">
        <div className="brand-mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="8"
              stroke="currentColor"
              strokeOpacity="0.6"
              strokeWidth="1.5"
            />
            <circle cx="12" cy="12" r="3.5" fill="currentColor" />
          </svg>
        </div>
        <span className="brand-name">{BANK_NAME}</span>
      </div>
      {label && (
        <span className="header-label">
          <span className="header-dot" />
          {label}
        </span>
      )}
    </header>
  );
}

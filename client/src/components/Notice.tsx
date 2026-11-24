import { CheckIcon } from './icons';

/** The large, slowly pulsing notice above the login page's headline. */
export function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="notice" role="status">
      <div className="notice-halo" aria-hidden="true" />
      <div className="notice-ring" aria-hidden="true" />
      <div className="notice-base" aria-hidden="true" />
      <span className="notice-icon" aria-hidden="true">
        <CheckIcon />
      </span>
      <span className="notice-text">
        <strong className="notice-title">{title}</strong>
        <span className="notice-body">{body}</span>
      </span>
    </div>
  );
}

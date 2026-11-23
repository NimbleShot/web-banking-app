import { triesAlert } from '../forms/passcode';
import { AlertIcon } from './icons';

export function FormAlert({ title, body }: { title: string; body?: string }) {
  return (
    <div className="alert" role="alert">
      <AlertIcon />
      <div className="alert-text">
        <strong className="alert-title">{title}</strong>
        {body && <span>{body}</span>}
      </div>
    </div>
  );
}

export function TriesAlert({ id, triesLeft }: { id: string; triesLeft: number }) {
  const { title, body, label } = triesAlert(triesLeft);
  return (
    <div id={id} className="alert" role="alert">
      <AlertIcon />
      <div className="alert-text">
        <strong className="alert-title">{title}</strong>
        <span>{body}</span>
      </div>
      <div className="tries">
        {/* The key restarts the number's small pop each time it changes. */}
        <span key={triesLeft} className="tries-number">
          {triesLeft}
        </span>
        <span className="tries-label">{label}</span>
      </div>
    </div>
  );
}

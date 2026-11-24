import type { ReactNode } from 'react';
import { triesAlert } from '../forms/passcode';
import { AlertIcon } from './icons';

type FormAlertProps = { id?: string; title: string; body?: ReactNode };

export function FormAlert({ id, title, body }: FormAlertProps) {
  return (
    <div id={id} className="alert" role="alert">
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
    // Focusable, so it can hold the focus while a locked code's button still counts down.
    <div id={id} className="alert" role="alert" tabIndex={-1}>
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

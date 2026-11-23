import { useState, type ComponentProps, type ReactNode } from 'react';
import { AlertIcon, EyeIcon } from './icons';

type FieldProps = {
  id: string;
  label: string;
  hint?: string;
  error?: ReactNode;
  children: ReactNode;
};

/** A label, its control, and either a hint or the field's error below it. */
export function Field({ id, label, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children}
      {error ? (
        <span id={`${id}-message`} className="field-error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </span>
      ) : (
        hint && (
          <span id={`${id}-message`} className="field-hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

type InputProps = ComponentProps<'input'> & {
  id: string;
  invalid: boolean;
  /** Whether the field shows a hint or error, which the input then points to. */
  described: boolean;
};

export function Input({ invalid, described, className = '', ...props }: InputProps) {
  return (
    <input
      {...props}
      className={`input ${invalid ? 'input-bad' : ''} ${className}`}
      aria-invalid={invalid}
      aria-describedby={described ? `${props.id}-message` : undefined}
    />
  );
}

export function PasswordInput(props: Omit<InputProps, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-wrap">
      <Input {...props} type={shown ? 'text' : 'password'} className="input-with-toggle" />
      <button
        type="button"
        className="input-toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        <EyeIcon />
      </button>
    </div>
  );
}

import { useState, type ComponentProps, type ReactNode } from 'react';
import { AlertIcon, EyeIcon } from './icons';

type FieldProps = {
  id: string;
  label: string;
  hint?: string;
  error?: ReactNode;
  /** A confirmation in place of the hint, such as "Passwords match.". */
  ok?: string | undefined;
  /** The error as an announced line of text, without the icon. */
  plainError?: boolean;
  /** A link on the label's line, such as "Forgot password?". */
  aside?: ReactNode;
  children: ReactNode;
};

/** A label, its control, and a hint, confirmation or error below it. */
export function Field({ id, label, hint, error, ok, plainError, aside, children }: FieldProps) {
  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <span id={`${id}-message`} className="field-error" role={plainError ? 'alert' : undefined}>
          {!plainError && <AlertIcon size={15} />}
          <span>{error}</span>
        </span>
      ) : ok ? (
        <span id={`${id}-message`} className="field-ok">
          {ok}
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
  /** Another element that explains the field, such as a form-level alert. */
  describedBy?: string | undefined;
};

export function Input({ invalid, described, describedBy, className = '', ...props }: InputProps) {
  return (
    <input
      {...props}
      className={`input ${invalid ? 'input-bad' : ''} ${className}`}
      aria-invalid={invalid}
      aria-describedby={describedBy ?? (described ? `${props.id}-message` : undefined)}
    />
  );
}

type PasswordInputProps = Omit<InputProps, 'type'> & {
  /** Set with `onToggle` when one eye button shows two fields at once. */
  shown?: boolean;
  onToggle?: () => void;
  noun?: string;
};

export function PasswordInput({
  shown,
  onToggle,
  noun = 'password',
  ...props
}: PasswordInputProps) {
  const [ownShown, setOwnShown] = useState(false);
  const visible = shown ?? ownShown;
  return (
    <div className="input-wrap">
      <Input {...props} type={visible ? 'text' : 'password'} className="input-with-toggle" />
      <button
        type="button"
        className="input-toggle"
        aria-label={`${visible ? 'Hide' : 'Show'} ${noun}`}
        aria-pressed={visible}
        onClick={onToggle ?? (() => setOwnShown(!ownShown))}
      >
        <EyeIcon />
      </button>
    </div>
  );
}

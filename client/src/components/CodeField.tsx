import { useState, type Ref } from 'react';
import { CODE_LENGTH, codeDigits } from '../forms/passcode';

type CodeFieldProps = {
  legend: string;
  inputLabel: string;
  value: string;
  onChange: (digits: string) => void;
  invalid: boolean;
  locked: boolean;
  describedBy?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
};

/**
 * One real input (so paste and the phone's one-time-code autofill work) lying invisibly over six
 * drawn cells.
 */
export function CodeField({
  legend,
  inputLabel,
  value,
  onChange,
  invalid,
  locked,
  describedBy,
  inputRef,
}: CodeFieldProps) {
  const [focused, setFocused] = useState(false);
  const activeCell = Math.min(value.length, CODE_LENGTH - 1);

  return (
    <fieldset className="code-field">
      <legend className="field-label code-legend">{legend}</legend>
      <div className="code-wrap">
        <div className="code-cells" aria-hidden="true">
          {Array.from({ length: CODE_LENGTH }, (_, index) => {
            const digit = value.charAt(index);
            const state = invalid
              ? 'code-cell-bad'
              : focused && index === activeCell
                ? 'code-cell-active'
                : digit
                  ? 'code-cell-filled'
                  : '';
            return (
              <span key={index} className={`code-cell ${state}`}>
                {digit}
              </span>
            );
          })}
        </div>
        <input
          ref={inputRef}
          className="code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          aria-label={inputLabel}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={locked}
          value={value}
          onChange={(event) => onChange(codeDigits(event.target.value))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
    </fieldset>
  );
}

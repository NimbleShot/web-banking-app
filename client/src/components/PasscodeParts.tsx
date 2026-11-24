import type { Ref } from 'react';
import type { PasscodeFlow } from '../forms/usePasscode';
import { FormAlert, TriesAlert } from './Alerts';
import { RefreshIcon } from './icons';

type PartProps = { flow: PasscodeFlow };

/** The tries left, any failure, and the note that a new code was sent. */
export function PasscodeAlerts({ flow, alertId }: PartProps & { alertId: string }) {
  return (
    <>
      {flow.showTries && <TriesAlert id={alertId} triesLeft={flow.triesLeft} />}
      {flow.problem && <FormAlert title={flow.problem} />}
      {flow.newCodeSent && (
        // The server answers alike whether or not it sent one, so this never claims it did.
        <p className="form-status" role="status">
          {"A new code should arrive shortly. If it doesn't, wait an hour and try again."}
        </p>
      )}
    </>
  );
}

/** Replaces the submit button once the code is locked. */
export function NewCodeButton({
  flow,
  buttonRef,
}: PartProps & { buttonRef: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="button-primary button-lock"
      disabled={!flow.canResend}
      onClick={() => void flow.resend()}
    >
      <RefreshIcon />
      {flow.resendLabel}
    </button>
  );
}

export function ResendRow({ flow }: PartProps) {
  if (flow.locked) return null;
  return (
    <div className="resend-row">
      <span>Didn&apos;t get it?</span>
      <button
        type="button"
        className="link-button"
        disabled={!flow.canResend}
        onClick={() => void flow.resend()}
      >
        {flow.resendLabel}
      </button>
    </div>
  );
}

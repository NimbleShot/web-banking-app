// Sending passcodes (docs/decisions/0001). The outbox implements it in tests and development.
import type { PasscodePurpose } from '../services/passcodes';

export type PasscodeMessage = {
  /** The lowercased email address. */
  to: string;
  purpose: PasscodePurpose;
  /** The 6-digit passcode. */
  passcode: string;
};

export type Mailer = {
  sendPasscode(message: PasscodeMessage): Promise<void>;
};

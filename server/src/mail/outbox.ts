// The in-memory mailer: keeps every message instead of sending it (docs/decisions/0001, 0012).
import type { Mailer, PasscodeMessage } from './mailer';

export class OutboxMailer implements Mailer {
  /** Every message sent, oldest first. */
  readonly messages: PasscodeMessage[] = [];

  async sendPasscode(message: PasscodeMessage): Promise<void> {
    this.messages.push({ ...message });
  }

  /** Every message sent to `email` (lowercased), oldest first. */
  sentTo(email: string): PasscodeMessage[] {
    return this.messages.filter((message) => message.to === email);
  }
}

// Helpers that talk to the API directly, for a test's setup and to read the emailed passcode.
import { newTransferKey } from '../../src/api/transfer';

export const PASSWORD = 'correct-horse-9';
export const PHONE = '+972501234567';

const apiUrl = () => Cypress.expose('apiUrl') as string;

let emails = 0;

export function uniqueEmail(): string {
  emails += 1;
  return `user${emails}-${Date.now()}@example.com`;
}

/** The latest passcode the test outbox holds for an email. */
export function latestCode(email: string): Cypress.Chainable<string> {
  return cy
    .request(`${apiUrl()}/__test/outbox?email=${encodeURIComponent(email)}`)
    .its('body.passcode');
}

/** The latest code, which must be a password-reset one rather than the sign-up's. */
export function latestResetCode(email: string): Cypress.Chainable<string> {
  return cy
    .request(`${apiUrl()}/__test/outbox?email=${encodeURIComponent(email)}`)
    .its('body')
    .then((body: { purpose: string; passcode: string }) => {
      expect(body.purpose).to.equal('reset');
      return body.passcode;
    });
}

/** A well-formed code that is certainly not the right one. */
export function wrongCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

/** Moves money through the API, as the token's user. */
export function sendMoney(token: string, toEmail: string, amount: number) {
  return cy.request({
    method: 'POST',
    url: `${apiUrl()}/api/v1/transfers`,
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': newTransferKey() },
    body: { toEmail, amount },
  });
}

/** The balance in agorot, as the API reports it. */
export function balanceOf(token: string): Cypress.Chainable<number> {
  return cy
    .request({ url: `${apiUrl()}/api/v1/me`, headers: { Authorization: `Bearer ${token}` } })
    .its('body.balance');
}

/** Sets the browser's reduced-motion preference, for what the page's CSS and scripts both see. */
export function setReducedMotion(value: 'reduce' | 'no-preference') {
  return cy.wrap(
    Cypress.automation('remote:debugger:protocol', {
      command: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-reduced-motion', value }] },
    }),
    { log: false },
  );
}

/** Opens a page already signed in with a token. */
export function visitSignedIn(path: string, token: string) {
  return cy.visit(path, {
    onBeforeLoad(win) {
      win.sessionStorage.setItem('bank.accessToken', token);
    },
  });
}

/** Creates a verified user through the API. */
export function registerUser(email: string) {
  const details = { email, password: PASSWORD, phone: PHONE };
  return cy
    .request('POST', `${apiUrl()}/api/v1/auth/signup`, details)
    .then(() =>
      latestCode(email).then((passcode) =>
        cy.request('POST', `${apiUrl()}/api/v1/auth/otp/verify`, { ...details, passcode }),
      ),
    );
}

import { latestCode, PASSWORD, registerUser, uniqueEmail, wrongCode } from '../support/api';

const CODE_INPUT = 'input[autocomplete="one-time-code"]';

function fillSignUp(email: string, phone = '050-123-4567', password = PASSWORD) {
  cy.get('#signup-email').clear().type(email);
  cy.get('#signup-phone').clear().type(phone);
  cy.get('#signup-password').clear().type(password);
  cy.contains('button', 'Create account').click();
}

function enterCode(code: string) {
  cy.get(CODE_INPUT).clear({ force: true }).type(code, { force: true });
  cy.contains('button', 'Verify and continue').click();
}

/** Puts text into the focused field in one go, as a paste or the phone's code autofill does. */
function pasteText(text: string) {
  return cy.wrap(
    Cypress.automation('remote:debugger:protocol', {
      command: 'Input.insertText',
      params: { text },
    }),
    { log: false },
  );
}

const PASSCODE_INVALID = {
  statusCode: 401,
  headers: { 'content-type': 'application/problem+json' },
  body: { type: 'about:blank', title: 'PASSCODE_INVALID', status: 401, code: 'PASSCODE_INVALID' },
};

function expectNoSecretsStored() {
  cy.window().then((win) => {
    const stored = JSON.stringify({ ...win.localStorage, ...win.sessionStorage });
    expect(stored).not.to.contain(PASSWORD);
    expect(stored).not.to.contain('501234567');
  });
}

describe('sign-up and passcode screens', () => {
  it('[UX-2] valid details and the right code reach the dashboard, keeping the password and phone out of browser storage', () => {
    const email = uniqueEmail();
    cy.intercept('POST', '/api/v1/auth/signup').as('signUp');
    cy.visit('/signup');
    fillSignUp(email);

    cy.wait('@signUp').its('request.body.phone').should('eq', '+972501234567');
    cy.location('pathname').should('eq', '/verify');
    cy.contains('strong', email);
    expectNoSecretsStored();

    latestCode(email).then((code) => enterCode(code));
    cy.location('pathname').should('eq', '/dashboard');
    cy.window().then((win) => {
      expect(win.sessionStorage.getItem('bank.accessToken')).to.be.a('string');
    });
    expectNoSecretsStored();
  });

  it('[UX-2] each bad field shows its own error and sends nothing, and a taken email offers sign-in', () => {
    cy.intercept('POST', '/api/v1/auth/signup').as('signUp');
    cy.visit('/signup');
    fillSignUp('not-an-email', '50 12', 'short');

    cy.contains('#signup-email-message', 'Enter a valid email address.');
    cy.contains('#signup-phone-message', 'Enter the full number, like 50 123 4567.');
    cy.contains('#signup-password-message', 'Use at least 8 characters.');
    cy.get('#signup-email').should('have.attr', 'aria-invalid', 'true').and('be.focused');
    cy.get('@signUp.all').should('have.length', 0);

    const taken = uniqueEmail();
    registerUser(taken);
    fillSignUp(taken);
    cy.contains('#signup-email-message', 'This email already has an account.')
      .find('a')
      .should('have.attr', 'href', '/login');
    cy.location('pathname').should('eq', '/signup');
  });

  it('[UX-2] a wrong code counts down the tries, and at zero locks the field and offers a new code after the countdown', () => {
    // Only the page's clock is faked. The server's own cooldown stays real, so this test never
    // relies on the resent code arriving.
    cy.clock(Date.now(), ['Date', 'setInterval', 'clearInterval']);
    const email = uniqueEmail();
    cy.intercept('POST', '/api/v1/auth/otp/resend').as('resend');
    cy.visit('/signup');
    fillSignUp(email);
    cy.location('pathname').should('eq', '/verify');

    latestCode(email).then((code) => {
      const wrong = wrongCode(code);
      for (const left of [4, 3, 2]) {
        enterCode(wrong);
        cy.contains('.tries-number', String(left));
        cy.contains('.tries-label', 'TRIES LEFT');
      }
      enterCode(wrong);
      cy.contains('.tries-number', '1');
      cy.contains('.tries-label', 'TRY LEFT');
      cy.contains('[role="alert"]', 'One more wrong code');
      enterCode(wrong);
    });

    cy.contains('[role="alert"]', 'No tries left.');
    cy.contains('.tries-number', '0');
    cy.get(CODE_INPUT).should('be.disabled');
    cy.contains('button', 'Send a new code in').should('be.disabled');
    cy.get('@resend.all').should('have.length', 0);

    cy.tick(60_000);
    cy.contains('button', /^Send a new code$/)
      .should('be.enabled')
      .click();
    cy.wait('@resend').its('request.body.email').should('eq', email);
    cy.get('.tries-number').should('not.exist');
    cy.get(CODE_INPUT).should('be.enabled').and('have.value', '');
    cy.contains('[role="status"]', 'A new code should arrive shortly.');
    cy.contains('button', 'Send a new code in').should('be.disabled');
  });

  it('[UX-2] a reload on the code screen returns to sign-up, because the password lives only in memory', () => {
    cy.visit('/signup');
    fillSignUp(uniqueEmail());
    cy.location('pathname').should('eq', '/verify');

    cy.reload();
    cy.location('pathname').should('eq', '/signup');
    cy.get('#signup-password').should('have.value', '');
  });
  it('[UX-2] a pasted code keeps all six digits, even with spaces around and inside it', () => {
    const email = uniqueEmail();
    cy.visit('/signup');
    fillSignUp(email);
    cy.location('pathname').should('eq', '/verify');

    latestCode(email).then((code) => {
      cy.get(CODE_INPUT).focus();
      pasteText(` ${code.slice(0, 3)} ${code.slice(3)}`);
      cy.get(CODE_INPUT).should('have.value', code);
    });
    cy.contains('button', 'Verify and continue').should('be.enabled').click();
    cy.location('pathname').should('eq', '/dashboard');
  });

  it('[UX-2] going back from the code screen keeps the email and phone, but never puts the password back', () => {
    const email = uniqueEmail();
    cy.visit('/signup');
    fillSignUp(email);
    cy.location('pathname').should('eq', '/verify');

    cy.contains('a', 'Go back').click();
    cy.location('pathname').should('eq', '/signup');
    cy.get('#signup-email').should('have.value', email);
    cy.get('#signup-phone').should('have.value', '050-123-4567');
    cy.get('#signup-password').should('have.value', '');
  });

  it('[UX-2] a code locked while the new-code button still counts down keeps the focus on the alert, then moves it to the button', () => {
    cy.clock(Date.now(), ['Date', 'setInterval', 'clearInterval']);
    // The server's refusal is played back, so this test spends none of the wrong-code allowance.
    cy.intercept('POST', '/api/v1/auth/otp/verify', PASSCODE_INVALID);
    cy.visit('/signup');
    fillSignUp(uniqueEmail());
    cy.location('pathname').should('eq', '/verify');

    for (const left of [4, 3, 2, 1, 0]) {
      enterCode('000000');
      cy.contains('.tries-number', String(left));
    }
    cy.contains('button', 'Send a new code in').should('be.disabled');
    cy.focused().should('contain.text', 'No tries left.');

    cy.tick(60_000);
    cy.contains('button', /^Send a new code$/)
      .should('be.enabled')
      .and('have.focus');
  });

  it("[UX-2] an email the server refuses shows the app's own message, not the server's wording", () => {
    cy.intercept('POST', '/api/v1/auth/signup').as('signUp');
    cy.visit('/signup');
    fillSignUp('dana@example..com');
    cy.wait('@signUp').its('response.statusCode').should('eq', 400);
    cy.contains('Enter a valid email address.');
    cy.contains('must match').should('not.exist');
    cy.location('pathname').should('eq', '/signup');
  });
});

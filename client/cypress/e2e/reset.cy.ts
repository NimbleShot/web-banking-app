import { latestResetCode, PASSWORD, registerUser, uniqueEmail, wrongCode } from '../support/api';

const CODE_INPUT = 'input[autocomplete="one-time-code"]';
const NEW_PASSWORD = 'brand-new-secret-4';

function askForCode(email: string) {
  cy.get('#forgot-email').clear().type(email);
  cy.contains('button', 'Send code').click();
  cy.location('pathname').should('eq', '/reset');
}

function fillReset(code: string, password = NEW_PASSWORD, retype = password) {
  cy.get(CODE_INPUT).clear({ force: true }).type(code, { force: true });
  cy.get('#reset-password').clear().type(password);
  cy.get('#reset-password2').clear().type(retype);
  cy.contains('button', 'Set new password').click();
}

function signIn(email: string, password: string) {
  cy.get('#login-email').clear().type(email);
  cy.get('#login-password').clear().type(password);
  cy.contains('button', 'Sign in').click();
}

describe('forgot-password and reset screens', () => {
  it('[UX-4] a correct code with a matching new password ends at sign-in with the notice, and only the new password works', () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.visit('/forgot');
    askForCode(email);

    latestResetCode(email).then((code) => fillReset(code));
    cy.location('pathname').should('eq', '/login');
    cy.contains('[role="status"]', 'Password reset successful');

    signIn(email, PASSWORD);
    cy.contains('#login-error', 'The email or password is incorrect.');
    signIn(email, NEW_PASSWORD);
    cy.location('pathname').should('eq', '/dashboard');
  });

  it('[UX-4] any well-formed email gets the same wording, and a malformed one sends nothing', () => {
    const known = uniqueEmail();
    const unknown = uniqueEmail();
    registerUser(known);
    cy.intercept('POST', '/api/v1/auth/password/forgot').as('forgot');
    cy.visit('/forgot');

    cy.get('#forgot-email').type('not-an-email');
    cy.contains('button', 'Send code').click();
    cy.contains('#forgot-email-message', 'Enter a valid email address.');
    cy.get('@forgot.all').should('have.length', 0);

    const wording = (email: string) =>
      cy
        .get('.card-lead')
        .invoke('text')
        .then((text) => text.replace(email, 'EMAIL'));

    askForCode(known);
    wording(known).then((forKnown) => {
      cy.contains('a', 'Go back').click();
      askForCode(unknown);
      wording(unknown).should('eq', forKnown);
    });
    cy.get('@forgot.all').should('have.length', 2);
  });

  it('[UX-4] a wrong code shows the tries left, locks at zero and offers a new code after the countdown', () => {
    cy.clock(Date.now(), ['Date', 'setInterval', 'clearInterval']);
    const email = uniqueEmail();
    registerUser(email);
    cy.intercept('POST', '/api/v1/auth/password/forgot').as('forgot');
    cy.visit('/forgot');
    askForCode(email);

    latestResetCode(email).then((code) => {
      const wrong = wrongCode(code);
      for (const left of [4, 3, 2, 1]) {
        fillReset(wrong);
        cy.contains('.tries-number', String(left));
      }
      cy.contains('.tries-label', 'TRY LEFT');
      fillReset(wrong);
    });

    cy.contains('[role="alert"]', 'No tries left.');
    cy.get(CODE_INPUT).should('be.disabled');
    cy.contains('button', 'Send a new code in').should('be.disabled');

    cy.tick(60_000);
    cy.contains('button', /^Send a new code$/)
      .should('be.enabled')
      .click();
    cy.get('@forgot.all').should('have.length', 2);
    cy.get('.tries-number').should('not.exist');
    cy.get(CODE_INPUT).should('be.enabled').and('have.value', '');
  });

  it('[UX-4] a retype mismatch costs no try and sends nothing, and the same code then works', () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.intercept('POST', '/api/v1/auth/password/reset').as('reset');
    cy.visit('/forgot');
    askForCode(email);

    latestResetCode(email).then((code) => {
      fillReset(code, NEW_PASSWORD, 'something-else-7');
      cy.contains('#reset-password2-message', "The passwords don't match.");
      cy.get('#reset-password2').should('have.attr', 'aria-invalid', 'true').and('be.focused');
      cy.get('.tries-number').should('not.exist');
      cy.get('@reset.all').should('have.length', 0);

      cy.get('#reset-password2').clear().type(NEW_PASSWORD);
      cy.contains('#reset-password2-message', 'Passwords match.');
      cy.contains('button', 'Set new password').click();
    });
    cy.location('pathname').should('eq', '/login');
    cy.contains('[role="status"]', 'Password reset successful');
  });
});

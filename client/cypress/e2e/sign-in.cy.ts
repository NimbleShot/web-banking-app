import { PASSWORD, registerUser, uniqueEmail } from '../support/api';

const TOKEN_KEY = 'bank.accessToken';

function signIn(email: string, password = PASSWORD) {
  cy.get('#login-email').clear().type(email);
  cy.get('#login-password').clear().type(password);
  cy.contains('button', 'Sign in').click();
}

function expectToken(present: boolean) {
  cy.window().then((win) => {
    const token = win.sessionStorage.getItem(TOKEN_KEY);
    if (present) expect(token).to.be.a('string');
    else expect(token).to.equal(null);
  });
}

describe('sign-in and sign-out screens', () => {
  it('[UX-3] correct details reach the dashboard', () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.visit('/login');
    cy.contains('h1', 'Welcome to Parsec');
    signIn(email);

    cy.location('pathname').should('eq', '/dashboard');
    expectToken(true);
  });

  it('[UX-3] a wrong password and an unknown email get the same message, marking both fields', () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.visit('/login');

    const expectRejected = () => {
      cy.contains('#login-error', 'The email or password is incorrect.');
      cy.get('#login-email').should('have.attr', 'aria-invalid', 'true');
      cy.get('#login-password').should('have.attr', 'aria-invalid', 'true');
      cy.location('pathname').should('eq', '/login');
      expectToken(false);
      return cy.get('#login-error').invoke('text');
    };

    signIn(email, 'not-the-password');
    expectRejected().then((wrongPassword) => {
      signIn(uniqueEmail(), 'not-the-password');
      expectRejected().should('eq', wrongPassword);
    });
    cy.get('#login-error a').should('have.attr', 'href', '/forgot');
  });

  it("[UX-3] sign-out removes the token, shows the notice at login, and Back doesn't reopen the dashboard", () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.visit('/login');
    signIn(email);
    cy.location('pathname').should('eq', '/dashboard');
    // A second history entry, so the dashboard is what Back returns to after sign-out.
    cy.visit('/transfer');

    cy.contains('button', 'Sign out').click();
    cy.location('pathname').should('eq', '/login');
    cy.contains('[role="status"]', "You've signed out");
    expectToken(false);

    cy.go('back');
    cy.location('pathname').should('eq', '/login');
    cy.get('#login-email').should('be.visible');
    cy.contains('button', 'Sign out').should('not.exist');
    expectToken(false);
  });
  it('[UX-3] leaving the sign-in form before its answer arrives keeps the user where they went, signed out', () => {
    const email = uniqueEmail();
    registerUser(email);
    let release: (() => void) | undefined;
    cy.intercept(
      'POST',
      '/api/v1/auth/login',
      (req) =>
        new Promise<void>((resolve) => {
          release = () => {
            req.continue();
            resolve();
          };
        }),
    ).as('login');
    cy.visit('/login');
    signIn(email);
    cy.contains('a', 'Create an account').click();
    cy.location('pathname').should('eq', '/signup');

    cy.wrap(null)
      .should(() => expect(release, 'the request has arrived').to.be.a('function'))
      .then(() => release?.());
    cy.wait('@login');
    cy.wait(500);
    cy.location('pathname').should('eq', '/signup');
    expectToken(false);
  });
});

import {
  balanceOf,
  latestCode,
  PASSWORD,
  registerUser,
  setReducedMotion,
  uniqueEmail,
} from '../support/api';

const TOKEN_KEY = 'bank.accessToken';

const shekels = (agorot: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    agorot / 100,
  );

function signUp(email: string) {
  cy.visit('/');
  cy.location('pathname').should('eq', '/login');
  cy.contains('a', 'Create an account').click();

  cy.location('pathname').should('eq', '/signup');
  cy.get('#signup-email').type(email);
  cy.get('#signup-phone').type('050-123-4567');
  cy.get('#signup-password').type(PASSWORD);
  cy.contains('button', 'Create account').click();

  cy.location('pathname').should('eq', '/verify');
  latestCode(email).then((code) => {
    cy.get('input[autocomplete="one-time-code"]').type(code, { force: true });
  });
  cy.contains('button', 'Verify and continue').click();
  cy.location('pathname').should('eq', '/dashboard');
}

const storedToken = () =>
  cy.window().then((win): string => win.sessionStorage.getItem(TOKEN_KEY) ?? '');

describe('the main journey', () => {
  // The journey checks where the money ends up, so it doesn't wait through the balance's count.
  beforeEach(() => {
    setReducedMotion('reduce');
  });

  it('[UX-8] a new user signs up, reads the emailed code, reaches the dashboard, sends money and signs out', () => {
    const email = uniqueEmail();
    const recipient = uniqueEmail();

    registerUser(recipient)
      .its('body.accessToken')
      .then((recipientToken: string) => {
        balanceOf(recipientToken).then((recipientBefore) => {
          signUp(email);

          storedToken().then((token) => {
            balanceOf(token).then((start) => {
              cy.get('.balance-value').should('have.text', `${shekels(start)}₪`);
              cy.get('.tx-row').should('not.exist');

              cy.contains('a', 'Send money').click();
              cy.location('pathname').should('eq', '/transfer');
              cy.get('#transfer-to').type(recipient);
              cy.get('#transfer-amount').type('12.50');
              cy.contains('form button', 'Send 12.50 ₪').click();

              cy.location('pathname').should('eq', '/dashboard');
              cy.get('.balance-value').should('have.text', `${shekels(start - 1250)}₪`);
              cy.get('.tx-who').should('have.text', `Sent to ${recipient}`);
              cy.get('.tx-amount').should('have.text', '−12.50 ₪');
              balanceOf(token).should('eq', start - 1250);
              balanceOf(recipientToken).should('eq', recipientBefore + 1250);

              cy.contains('button', 'Sign out').click();
              cy.location('pathname').should('eq', '/login');
              cy.contains('[role="status"]', "You've signed out");
              storedToken().should('equal', '');
              cy.visit('/dashboard');
              cy.location('pathname').should('eq', '/login');
            });
          });
        });
      });
  });
});

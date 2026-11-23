import { balanceOf, registerUser, sendMoney, uniqueEmail, visitSignedIn } from '../support/api';

/** The expected text, worked out separately from the screen's own formatting. */
const shekels = (agorot: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    agorot / 100,
  );

const WHEN = /^(Today|Yesterday), \d\d:\d\d$/;

function expectRow(index: number, verb: string, email: string, amount: string) {
  cy.get('.tx-row')
    .eq(index)
    .within(() => {
      cy.get('.tx-who').should('have.text', `${verb} ${email}`);
      cy.get('.tx-amount').should('have.text', amount);
      cy.get('.tx-when').invoke('text').should('match', WHEN);
    });
}

describe('dashboard screen', () => {
  it('[UX-5] a signed-out visit goes to login and asks the API for nothing', () => {
    cy.intercept('GET', '/api/v1/me').as('me');
    cy.visit('/dashboard');
    cy.location('pathname').should('eq', '/login');
    cy.get('#login-email').should('be.visible');
    cy.get('@me.all').should('have.length', 0);
  });

  it('[UX-5] the balance and the newest 20 transactions show counterparty, signed amount and date', () => {
    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(me)
      .its('body.accessToken')
      .then((myToken: string) => {
        registerUser(other)
          .its('body.accessToken')
          .then((otherToken: string) => {
            // 21 transfers, so the oldest (1.01) must drop off the list of 20.
            for (let i = 1; i <= 20; i += 1) sendMoney(myToken, other, 100 + i);
            sendMoney(otherToken, me, 1050);

            balanceOf(myToken).then((balance) => {
              visitSignedIn('/dashboard', myToken);
              cy.get('.balance-value').should('have.text', `${shekels(balance)}₪`);
            });
          });
      });

    cy.get('.header-email').should('have.text', me);
    cy.get('.tx-row').should('have.length', 20);
    expectRow(0, 'Received from', other, '+10.50 ₪');
    expectRow(1, 'Sent to', other, '\u22121.20 ₪');
    expectRow(19, 'Sent to', other, '\u22121.02 ₪');
    cy.contains('.tx-amount', '1.01').should('not.exist');
  });

  it('[UX-5] a new account shows the empty state', () => {
    registerUser(uniqueEmail())
      .its('body.accessToken')
      .then((token: string) => {
        balanceOf(token).then((balance) => {
          visitSignedIn('/dashboard', token);
          cy.get('.balance-value').should('have.text', `${shekels(balance)}₪`);
        });
      });
    cy.contains('.tx-empty', 'No transactions yet');
    cy.contains('.tx-empty', 'Money you send or receive will show up here.');
    cy.get('.tx-row').should('not.exist');
  });
});

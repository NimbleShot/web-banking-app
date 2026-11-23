import { balanceOf, registerUser, uniqueEmail, visitSignedIn } from '../support/api';

const shekels = (agorot: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    agorot / 100,
  );

function fillTransfer(to: string, amount: string) {
  cy.get('#transfer-to').clear().type(to);
  cy.get('#transfer-amount').clear().type(amount);
}

function send() {
  cy.get('form button[type="submit"]').click();
}

const tokenOf = (email: string) => registerUser(email).its('body.accessToken');

describe('send-money screen', () => {
  it("[UX-6] a valid transfer, even double-clicked, moves the money once and returns to the dashboard with the server's balance and record", () => {
    const sender = uniqueEmail();
    const receiver = uniqueEmail();
    cy.intercept('POST', '/api/v1/transfers').as('transfer');

    tokenOf(sender).then((senderToken: string) => {
      tokenOf(receiver).then((receiverToken: string) => {
        balanceOf(senderToken).then((senderBefore) => {
          balanceOf(receiverToken).then((receiverBefore) => {
            visitSignedIn('/transfer', senderToken);
            cy.contains('.card-lead', `${shekels(senderBefore)} ₪`);
            fillTransfer(receiver, '4.35');
            cy.contains('form button', 'Send 4.35 ₪').dblclick();

            cy.wait('@transfer').its('request.body').should('deep.equal', {
              toEmail: receiver,
              amount: 435,
            });
            cy.location('pathname').should('eq', '/dashboard');
            cy.get('.balance-value').should('have.text', `${shekels(senderBefore - 435)}₪`);
            cy.get('.tx-row').should('have.length', 1);
            cy.get('.tx-who').should('have.text', `Sent to ${receiver}`);
            cy.get('.tx-amount').should('have.text', '−4.35 ₪');
            cy.get('@transfer.all').should('have.length', 1);
            balanceOf(senderToken).should('eq', senderBefore - 435);
            balanceOf(receiverToken).should('eq', receiverBefore + 435);
          });
        });
      });
    });
  });

  it('[UX-6] a bad email, a bad amount and an amount over the limit show on their fields and send nothing', () => {
    cy.intercept('POST', '/api/v1/transfers').as('transfer');
    tokenOf(uniqueEmail()).then((token: string) => visitSignedIn('/transfer', token));

    fillTransfer('not-an-email', '12,50');
    send();
    cy.contains('#transfer-to-message', 'Enter a valid email address.');
    cy.contains('#transfer-amount-message', 'Enter an amount like 250 or 12.50.');
    cy.get('#transfer-to').should('have.attr', 'aria-invalid', 'true').and('be.focused');

    fillTransfer(uniqueEmail(), '1000000.01');
    send();
    cy.contains('#transfer-amount-message', 'You can send up to 1,000,000.00 ₪ at a time.');
    cy.get('@transfer.all').should('have.length', 0);
    cy.location('pathname').should('eq', '/transfer');
  });

  it('[UX-6] an unknown recipient, your own email and more than your balance show on their fields and move nothing', () => {
    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(other);
    tokenOf(me).then((token: string) => {
      balanceOf(token).then((before) => {
        visitSignedIn('/transfer', token);

        fillTransfer(uniqueEmail(), '10');
        send();
        cy.contains('#transfer-to-message', 'No account uses this email.');

        fillTransfer(me, '10');
        send();
        cy.contains('#transfer-to-message', "You can't send money to yourself.");

        fillTransfer(other, shekels(before + 100));
        send();
        cy.contains('#transfer-amount-message', "That's more than your balance.");

        cy.location('pathname').should('eq', '/transfer');
        balanceOf(token).should('eq', before);
      });
    });
  });
});

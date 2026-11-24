import { balanceOf, PASSWORD, registerUser, uniqueEmail, visitSignedIn } from '../support/api';

const TOKEN_KEY = 'bank.accessToken';
const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/me';
const TRANSFERS = '/api/v1/transfers';
const CONNECTION = "We couldn't reach the bank. Check your connection and try again.";
const SERVER = 'Something went wrong on our side. Try again in a moment.';
const UNKNOWN = "We can't tell if this transfer went through.";

const agorot = (text: string) => Number(text.replace(/\D/g, ''));

const problem = (status: number, code: string) => ({
  statusCode: status,
  headers: { 'content-type': 'application/problem+json' },
  body: { type: 'about:blank', title: code, status, code },
});

const tokenOf = (email: string) => registerUser(email).its('body.accessToken');

function signIn(email: string, password = PASSWORD) {
  cy.get('#login-email').clear().type(email);
  cy.get('#login-password').clear().type(password);
  cy.contains('button', 'Sign in').click();
}

function fillTransfer(to: string, amount: string) {
  cy.get('#transfer-to').clear().type(to);
  cy.get('#transfer-amount').clear().type(amount);
}

const submitButton = () => cy.get('form button[type="submit"]');

function expectToken(present: boolean) {
  cy.window().then((win) => {
    const token = win.sessionStorage.getItem(TOKEN_KEY);
    if (present) expect(token).to.be.a('string');
    else expect(token).to.equal(null);
  });
}

function expectSessionEnded() {
  cy.location('pathname').should('eq', '/login');
  cy.contains('.notice', 'Your session ended');
  cy.get('[role="alert"]').should('not.exist');
  expectToken(false);
}

/** Holds the next matching request unanswered. The returned function lets the answer go. */
function holdAnswer(method: 'GET' | 'POST', path: string, answer: ReturnType<typeof problem>) {
  let release: (() => void) | undefined;
  cy.intercept(
    method,
    path,
    (req) =>
      new Promise<void>((resolve) => {
        release = () => {
          req.reply(answer);
          resolve();
        };
      }),
  ).as('held');
  return () =>
    cy
      .wrap(null)
      .should(() => expect(release, 'the request has arrived').to.be.a('function'))
      .then(() => release?.());
}

describe('failure and session states', () => {
  it('[UX-7] a refused token returns to login with the notice, from the dashboard and in the middle of a transfer, moving no money', () => {
    visitSignedIn('/dashboard', 'not-a-real-token');
    expectSessionEnded();

    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(other);
    tokenOf(me).then((token: string) => {
      balanceOf(token).then((before) => {
        visitSignedIn('/transfer', token);
        cy.contains('.card-strong', '.');
        cy.window().then((win) => win.sessionStorage.setItem(TOKEN_KEY, 'no-longer-valid'));
        fillTransfer(other, '10');
        submitButton().click();

        expectSessionEnded();
        balanceOf(token).should('eq', before);
      });
    });
  });

  it('[UX-7] a refusal that arrives after the user signed in again leaves the new session alone', () => {
    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(other);
    const letAnswerGo = holdAnswer('POST', TRANSFERS, problem(401, 'UNAUTHORIZED'));

    tokenOf(me).then((token: string) => visitSignedIn('/transfer', token));
    fillTransfer(other, '10');
    submitButton().click();
    cy.contains('button', 'Sign out').click();
    signIn(me);
    cy.location('pathname').should('eq', '/dashboard');
    cy.contains('.balance-value', '.');

    letAnswerGo();
    cy.wait('@held');
    cy.wait(300);
    cy.location('pathname').should('eq', '/dashboard');
    expectToken(true);
  });

  it('[UX-7] on the sign-in form, a wrong password, a rate limit, a server failure and a lost connection each stay on the screen with a message, with submit disabled while sending', () => {
    const email = uniqueEmail();
    registerUser(email);
    cy.visit('/login');

    signIn(email, 'not-the-password');
    cy.contains('#login-error', 'The email or password is incorrect.');
    cy.get('.notice').should('not.exist');

    const limited = problem(429, 'RATE_LIMITED');
    cy.intercept('POST', LOGIN, {
      ...limited,
      headers: { ...limited.headers, 'Retry-After': '120' },
    });
    signIn(email);
    cy.contains('[role="alert"]', 'Too many tries. Wait 2 minutes and try again.');

    cy.intercept('POST', LOGIN, problem(500, 'INTERNAL_ERROR'));
    signIn(email);
    cy.contains('[role="alert"]', SERVER);

    cy.intercept('POST', LOGIN, { forceNetworkError: true });
    signIn(email);
    cy.contains('[role="alert"]', CONNECTION);

    const letAnswerGo = holdAnswer('POST', LOGIN, problem(500, 'INTERNAL_ERROR'));
    signIn(email);
    cy.contains('form button', 'Signing in…').should('be.disabled');
    letAnswerGo();
    cy.contains('form button', 'Sign in').should('not.be.disabled');
    cy.location('pathname').should('eq', '/login');
  });

  it('[UX-7] on the dashboard, a failed load shows a message and keeps the session, and so does a 401 for any other reason', () => {
    tokenOf(uniqueEmail()).then((token: string) => {
      cy.intercept('GET', ME, problem(500, 'INTERNAL_ERROR'));
      visitSignedIn('/dashboard', token);
      cy.contains('[role="alert"]', SERVER);

      cy.intercept('GET', ME, { forceNetworkError: true });
      cy.reload();
      cy.contains('[role="alert"]', CONNECTION);

      cy.intercept('GET', ME, problem(401, 'INVALID_CREDENTIALS'));
      cy.reload();
      cy.contains('[role="alert"]', SERVER);
      cy.location('pathname').should('eq', '/dashboard');
      expectToken(true);
    });
  });

  it('[UX-7] a transfer whose answer was lost asks the user to check, and the app never sends it by itself', () => {
    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(other);
    let appCalls = 0;

    tokenOf(me).then((token: string) => {
      // The server does the work, and the browser never hears back.
      cy.intercept('POST', TRANSFERS, (req) => {
        req.continue((res) => res.send({ forceNetworkError: true }));
      });
      cy.visit('/transfer', {
        onBeforeLoad(win) {
          win.sessionStorage.setItem(TOKEN_KEY, token);
          // Counts the app's own calls. The browser can repeat a request below this level.
          const realFetch = win.fetch.bind(win);
          win.fetch = (input, init) => {
            const isTransfer =
              input instanceof win.Request &&
              input.method === 'POST' &&
              input.url.endsWith(TRANSFERS);
            if (isTransfer) appCalls += 1;
            return realFetch(input, init);
          };
        },
      });
      fillTransfer(other, '4.35');
      submitButton().click();

      cy.contains('[role="alert"]', UNKNOWN);
      cy.contains('[role="alert"]', 'Check your transactions before you send it again.');
      cy.location('pathname').should('eq', '/transfer');
      cy.wait(1500).then(() => expect(appCalls).to.equal(1));

      cy.intercept('POST', TRANSFERS, problem(500, 'INTERNAL_ERROR'));
      submitButton().click();
      cy.wrap(null).should(() => expect(appCalls).to.equal(2));
      cy.contains('[role="alert"]', UNKNOWN);
      cy.wait(1000).then(() => expect(appCalls).to.equal(2));
    });
  });
  it('[TX-9] after a lost answer, sending the same transfer again moves the money once and reaches the dashboard', () => {
    const other = uniqueEmail();
    registerUser(other);
    tokenOf(uniqueEmail()).then((token: string) => {
      balanceOf(token).then((before) => {
        // The server makes the first transfer; only its answer is lost.
        cy.intercept({ method: 'POST', url: TRANSFERS, times: 1 }, (req) => {
          req.continue((res) => res.send({ forceNetworkError: true }));
        });
        visitSignedIn('/transfer', token);
        fillTransfer(other, '4.35');
        submitButton().click();
        cy.contains('[role="alert"]', UNKNOWN);

        submitButton().click();

        cy.location('pathname').should('eq', '/dashboard');
        balanceOf(token).should('equal', before - 435);
      });
    });
  });

  it('[UX-7] after a transfer whose answer was lost, the screen shows the balance the server now holds', () => {
    const other = uniqueEmail();
    registerUser(other);
    tokenOf(uniqueEmail()).then((token: string) => {
      balanceOf(token).then((before) => {
        cy.intercept('POST', TRANSFERS, (req) => {
          req.continue((res) => res.send({ forceNetworkError: true }));
        });
        visitSignedIn('/transfer', token);
        cy.get('.card-strong').should(($amount) => expect(agorot($amount.text())).to.equal(before));
        fillTransfer(other, '4.35');
        submitButton().click();

        cy.contains('[role="alert"]', UNKNOWN);
        balanceOf(token).then((now) => {
          expect(now, 'the server moved the money').to.be.below(before);
          cy.get('.card-strong').should(($amount) => expect(agorot($amount.text())).to.equal(now));
        });
      });
    });
  });
});

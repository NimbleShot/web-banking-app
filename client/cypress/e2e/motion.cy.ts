import {
  balanceOf,
  PASSWORD,
  registerUser,
  setReducedMotion,
  uniqueEmail,
  visitSignedIn,
} from '../support/api';

const CODE_INPUT = 'input[autocomplete="one-time-code"]';

/** Records every motion as it starts, so a test never depends on catching one mid-flight. */
function watchMotion(win: Cypress.AUTWindow, log: string[]) {
  win.document.addEventListener(
    'transitionrun',
    (event) => {
      const target = event.target as Element;
      if (target.matches('.hero')) log.push(`hero:${event.propertyName}`);
      if (target.matches('.frame')) log.push(`frame:${event.propertyName}`);
    },
    true,
  );
  const realAnimate = win.Element.prototype.animate;
  win.Element.prototype.animate = function animate(this: Element, keyframes, options) {
    const part = ['card-stage', 'card-panel'].find((name) => this.classList.contains(name));
    if (part && keyframes) for (const name of Object.keys(keyframes)) log.push(`${part}:${name}`);
    return realAnimate.call(this, keyframes, options);
  };
}

function openLogin(log: string[]) {
  cy.viewport(1440, 900);
  cy.visit('/login', { onBeforeLoad: (win) => watchMotion(win, log) });
  cy.get('#login-email').should('be.visible');
}

function settled() {
  cy.get('.card-stage, .card-panel, .hero, .frame').should(($parts) => {
    const running = $parts.toArray().flatMap((part) =>
      part.getAnimations().map((animation) => {
        const property = (animation as CSSTransition).transitionProperty ?? 'scripted';
        return `${part.className} ${property} ${animation.playState} at ${animation.currentTime}`;
      }),
    );
    expect(running).to.deep.equal([]);
  });
}

function expectCardCentred() {
  cy.get('.card').should(($card) => {
    const box = $card[0]!.getBoundingClientRect();
    expect(box.left + box.width / 2).to.be.closeTo(1440 / 2, 1.5);
  });
}

/** Follows one link or button, returning what moved and checking where the focus landed. */
function move(log: string[], go: () => void, path: string, focused: string, motion: string[]) {
  cy.then(() => {
    log.length = 0;
  });
  go();
  cy.location('pathname').should('eq', path);
  cy.focused().should('match', focused);
  settled();
  cy.then(() => {
    for (const name of motion) expect(log, 'motion that ran').to.include(name);
    if (motion.length === 0) expect(log, 'motion that ran').to.deep.equal([]);
  });
}

const link = (text: string) => () => cy.contains('a', text).click();

function fillSignUp(email: string) {
  cy.get('#signup-email').clear().type(email);
  cy.get('#signup-phone').clear().type('050-123-4567');
  cy.get('#signup-password').clear().type(PASSWORD);
}

/** An error makes the form taller, which only shows if no fixed height stayed on the card. */
function expectCardFollowsItsForm() {
  cy.get('.card')
    .invoke('outerHeight')
    .then((before) => {
      cy.get('#signup-email').clear();
      cy.get('#signup-password').clear();
      cy.contains('button', 'Create account').click();
      cy.get('#signup-password-message.field-error').should('be.visible');
      cy.get('.card').invoke('outerHeight').should('be.gt', before);
    });
}

describe('animated screen changes', () => {
  afterEach(() => {
    setReducedMotion('no-preference');
  });

  it('[UX-9] between the sign-in, sign-up, code and reset screens the card slides and reshapes while the hero fades, and the new form takes the focus', () => {
    const log: string[] = [];
    const email = uniqueEmail();
    const member = uniqueEmail();
    const card = ['card-stage:height', 'card-panel:opacity', 'card-panel:transform'];
    const hero = ['hero:opacity', 'hero:max-width', 'frame:column-gap'];

    setReducedMotion('no-preference');
    registerUser(member);
    openLogin(log);

    move(log, link('Create an account'), '/signup', '#signup-email', [...card, ...hero]);
    cy.get('.hero').should('have.css', 'visibility', 'hidden').and('have.css', 'opacity', '0');
    expectCardCentred();

    fillSignUp(email);
    move(log, () => cy.contains('button', 'Create account').click(), '/verify', CODE_INPUT, card);
    move(log, link('Go back'), '/signup', '#signup-email', card);
    expectCardFollowsItsForm();

    move(log, () => cy.get('.card-foot a').click(), '/login', '#login-email', [...card, ...hero]);
    cy.get('.hero').should('have.css', 'visibility', 'visible').and('have.css', 'opacity', '1');

    move(log, () => cy.contains('a', 'Forgot password?').click(), '/forgot', 'input', [
      ...card,
      ...hero,
    ]);
    cy.focused().type(member);
    move(log, () => cy.get('form button[type="submit"]').click(), '/reset', CODE_INPUT, card);
  });

  it('[UX-9] with reduced motion the screens switch at once, the new form still takes the focus, and the card follows its form', () => {
    const log: string[] = [];

    setReducedMotion('reduce');
    openLogin(log);

    move(log, link('Create an account'), '/signup', '#signup-email', []);
    cy.get('.hero').should('have.css', 'visibility', 'hidden');
    expectCardCentred();
    expectCardFollowsItsForm();

    move(log, () => cy.get('.card-foot a').click(), '/login', '#login-email', []);
    cy.get('.hero').should('have.css', 'visibility', 'visible');

    // The router also accepts this spelling, and it has to be the same landing page.
    cy.visit('/Login/');
    cy.get('.hero').should('have.css', 'visibility', 'visible');
    cy.contains('header', 'SECURE SIGN-IN');
  });
});

type CountSeen = { balance: number; amount: number; sign: string; rows: number };

const agorot = (text: string | null | undefined) => Number((text ?? '').replace(/\D/g, ''));

/** Records the balance and the amount from the same DOM update, on every change while counting. */
function recordCount(win: Cypress.AUTWindow, frames: CountSeen[]) {
  const observer = new win.MutationObserver(() => {
    const amount = win.document.querySelector('.balance-delta')?.textContent;
    if (!amount) return;
    const seen = {
      balance: agorot(win.document.querySelector('.balance-value')?.textContent),
      amount: agorot(amount),
      sign: amount.charAt(0),
      rows: win.document.querySelectorAll('.tx-row').length,
    };
    const last = frames.at(-1);
    if (last?.balance !== seen.balance || last.amount !== seen.amount) frames.push(seen);
  });
  observer.observe(win.document, { subtree: true, childList: true, characterData: true });
}

function sendFromScreen(to: string, amount: string) {
  cy.contains('.card-strong', '.');
  cy.get('#transfer-to').type(to);
  cy.get('#transfer-amount').type(amount);
  cy.get('form button[type="submit"]').click();
  cy.location('pathname').should('eq', '/dashboard');
}

/** Waits on the recorded frames, because the page is also "done" before its data has loaded. */
function countFinished(frames: CountSeen[]) {
  cy.wrap(frames, { timeout: 12_000, log: false }).should((seen: CountSeen[]) => {
    expect(seen.at(-1)?.amount, 'the amount left').to.equal(0);
  });
  cy.get('.balance-value-done', { timeout: 12_000 });
}

function expectEveryFrameAddsUp(frames: CountSeen[], start: number, size: number, end: number) {
  expect(frames.length, 'frames seen').to.be.greaterThan(5);
  expect(frames[0]).to.include({ balance: start, amount: size, sign: '−', rows: 0 });
  frames.reduce((previous, frame) => {
    expect(frame.balance - frame.amount, 'balance minus what is left').to.equal(end);
    expect(frame.amount, 'the amount never counts back').to.be.at.most(previous);
    expect(frame.sign).to.equal('−');
    if (frame.amount > 0) expect(frame.rows, 'the new row waits').to.equal(0);
    return frame.amount;
  }, size);
  expect(frames.at(-1)).to.include({ balance: end, amount: 0 });
}

describe('animated balance after a transfer', () => {
  const AMOUNT = 98_765;

  afterEach(() => {
    setReducedMotion('no-preference');
  });

  function twoUsers(run: (token: string, other: string, before: number) => void) {
    const me = uniqueEmail();
    const other = uniqueEmail();
    registerUser(other);
    registerUser(me)
      .its('body.accessToken')
      .then((token: string) => balanceOf(token).then((before) => run(token, other, before)));
  }

  it('[UX-10] a sent transfer shows the signed amount above the balance, both count until it is used up, every frame adds up, and neither a reload nor coming back replays it', () => {
    const frames: CountSeen[] = [];
    setReducedMotion('no-preference');
    cy.on('window:before:load', (win) => recordCount(win, frames));

    twoUsers((token, other, before) => {
      visitSignedIn('/transfer', token);
      sendFromScreen(other, '987.65');
      countFinished(frames);

      cy.then(() => expectEveryFrameAddsUp(frames, before, AMOUNT, before - AMOUNT));
      balanceOf(token).should('eq', before - AMOUNT);
      cy.get('.balance-delta').should('have.text', '');
      cy.get('.tx-row').should('have.length', 1);
      cy.get('[role="status"]').first().should('contain.text', 'Your balance is now');

      // Coming back first: a reload would also wipe what the page remembers in memory.
      cy.then(() => {
        frames.length = 0;
      });
      cy.contains('a', 'Send money').click();
      cy.contains('a', 'Back to your account').click();
      cy.location('pathname').should('eq', '/dashboard');
      cy.contains('.balance-value', '.');
      cy.wait(1_500).then(() => expect(frames, 'frames on coming back').to.deep.equal([]));

      cy.reload();
      cy.contains('.balance-value', '.');
      cy.wait(1_500).then(() => expect(frames, 'frames after a reload').to.deep.equal([]));
    });
  });

  it("[UX-10] the count ends on the server's balance, even when it isn't the old balance minus the amount", () => {
    const frames: CountSeen[] = [];
    const ARRIVED_MEANWHILE = 5_000;
    setReducedMotion('no-preference');
    cy.on('window:before:load', (win) => recordCount(win, frames));

    twoUsers((token, other, before) => {
      cy.intercept('GET', '/api/v1/me').as('firstLoad');
      visitSignedIn('/transfer', token);
      cy.wait('@firstLoad');
      cy.intercept('GET', '/api/v1/me', (req) => {
        req.continue((res) => {
          res.body.balance += ARRIVED_MEANWHILE;
        });
      });
      sendFromScreen(other, '987.65');
      countFinished(frames);

      const end = before - AMOUNT + ARRIVED_MEANWHILE;
      cy.then(() => expectEveryFrameAddsUp(frames, end + AMOUNT, AMOUNT, end));
      cy.get('.balance-value').should(($value) => expect(agorot($value.text())).to.equal(end));
    });
  });

  it("[UX-10] a transfer sent just before signing out is never counted on the next user's dashboard", () => {
    const frames: CountSeen[] = [];
    setReducedMotion('no-preference');
    cy.on('window:before:load', (win) => recordCount(win, frames));

    twoUsers((token, other) => {
      let release: (() => void) | undefined;
      // The sender's dashboard never hears back, so the sender signs out before it can count.
      cy.intercept(
        { method: 'GET', pathname: '/api/v1/transactions', times: 1 },
        (req) =>
          new Promise<void>((resolve) => {
            release = () => {
              req.continue();
              resolve();
            };
          }),
      );
      visitSignedIn('/transfer', token);
      sendFromScreen(other, '987.65');
      cy.contains('button', 'Sign out').click();
      cy.location('pathname').should('eq', '/login');

      cy.get('#login-email').type(other);
      cy.get('#login-password').type(PASSWORD);
      cy.contains('button', 'Sign in').click();
      cy.location('pathname').should('eq', '/dashboard');
      cy.get('.tx-row').should('have.length', 1);
      cy.then(() => release?.());
      cy.wait(1_500).then(() => expect(frames, 'count frames').to.deep.equal([]));
      cy.get('.balance [role="status"]').should('have.text', '');
    });
  });

  it('[UX-10] with reduced motion the new balance appears at once, with no amount above it', () => {
    const frames: CountSeen[] = [];
    setReducedMotion('reduce');
    cy.on('window:before:load', (win) => recordCount(win, frames));

    twoUsers((token, other, before) => {
      visitSignedIn('/transfer', token);
      sendFromScreen(other, '987.65');

      cy.get('.balance-value-done').should(($value) =>
        expect(agorot($value.text())).to.equal(before - AMOUNT),
      );
      cy.get('.tx-row').should('have.length', 1);
      cy.get('.balance-delta').should('have.text', '');
      cy.wait(1_500).then(() => expect(frames, 'count frames').to.deep.equal([]));
    });
  });
});

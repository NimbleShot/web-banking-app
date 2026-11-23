import { PASSWORD, registerUser, uniqueEmail } from '../support/api';

const CODE_INPUT = 'input[autocomplete="one-time-code"]';

function setReducedMotion(value: 'reduce' | 'no-preference') {
  return cy.wrap(
    Cypress.automation('remote:debugger:protocol', {
      command: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-reduced-motion', value }] },
    }),
    { log: false },
  );
}

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
  });
});

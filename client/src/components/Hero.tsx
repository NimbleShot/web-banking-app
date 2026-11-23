import type { ReactNode } from 'react';
import { BRAND_NAME } from '../brand';

/** The login page's headline. Folded away on the other signed-out screens. */
export function Hero({ notice, folded }: { notice?: ReactNode; folded: boolean }) {
  return (
    <section className={`hero ${folded ? 'hero-folded' : ''}`} aria-hidden={folded || undefined}>
      <div className="hero-inner">
        {notice}
        <span className="hero-eyebrow">{'// INSTANT TRANSFERS'}</span>
        <h1 className="hero-title">
          <span className="hero-welcome">Welcome to {BRAND_NAME}</span>
          <span className="hero-tagline">
            <span className="hero-where">where</span>
            money moves at the{' '}
            <span className="hero-light">
              <span className="hero-light-aura" aria-hidden="true" />
              <span className="hero-light-text">speed of light</span>
            </span>
          </span>
        </h1>
        <p className="hero-lead">
          See your balance, check your recent transfers and send money to anyone by their email
          address.
        </p>
      </div>
    </section>
  );
}

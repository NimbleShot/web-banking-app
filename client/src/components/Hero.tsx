import type { ReactNode } from 'react';
import { BRAND_NAME } from '../brand';

export function Hero({ notice }: { notice?: ReactNode }) {
  return (
    <section className="hero">
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
    </section>
  );
}

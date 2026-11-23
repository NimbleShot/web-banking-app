import type { ReactNode } from 'react';
import { BANK_NAME } from '../brand';
import { Background } from './Background';
import { Header } from './Header';
import { Hero } from './Hero';

type PageProps = {
  /** The browser tab's title, before the bank's name. */
  title: string;
  /** The small status label at the header's right. */
  label?: string;
  /** Only the login landing page has the hero; every other screen centres its card. */
  hero?: boolean;
  children: ReactNode;
};

export function Page({ title, label, hero = false, children }: PageProps) {
  return (
    <div className="page">
      <title>{`${title} · ${BANK_NAME}`}</title>
      <Background centered={!hero} />
      <Header label={label} />
      <main className="page-content">
        {hero && <Hero />}
        {children}
      </main>
    </div>
  );
}

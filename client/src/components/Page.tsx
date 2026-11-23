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
  /** A notice above the hero's headline. */
  notice?: ReactNode;
  /** Signed-in screens have the sign-out button in the header. */
  signedIn?: boolean;
  /** Shown beside the sign-out button once the account has loaded. */
  userEmail?: string | undefined;
  contentClassName?: string;
  children: ReactNode;
};

export function Page({
  title,
  label,
  hero = false,
  notice,
  signedIn = false,
  userEmail,
  contentClassName = '',
  children,
}: PageProps) {
  return (
    <div className="page">
      <title>{`${title} · ${BANK_NAME}`}</title>
      <Background centered={!hero} />
      <Header label={label} signedIn={signedIn} userEmail={userEmail} />
      <main className={`page-content ${contentClassName}`}>
        {hero && <Hero notice={notice} />}
        {children}
      </main>
    </div>
  );
}

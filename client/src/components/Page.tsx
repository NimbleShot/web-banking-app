import type { ReactNode } from 'react';
import { BANK_NAME } from '../brand';
import { Background } from './Background';
import { Header } from './Header';

type PageProps = {
  /** The browser tab's title, before the bank's name. */
  title: string;
  /** The small status label at the header's right. */
  label?: string;
  /** Signed-in screens have the sign-out button in the header. */
  signedIn?: boolean;
  /** Shown beside the sign-out button once the account has loaded. */
  userEmail?: string | undefined;
  contentClassName?: string;
  children: ReactNode;
};

/** The browser tab's title, before the bank's name. */
export function PageTitle({ title }: { title: string }) {
  return <title>{`${title} · ${BANK_NAME}`}</title>;
}

export function Page({
  title,
  label,
  signedIn = false,
  userEmail,
  contentClassName = '',
  children,
}: PageProps) {
  return (
    <div className="page">
      <PageTitle title={title} />
      <Background centered />
      <Header label={label} signedIn={signedIn} userEmail={userEmail} />
      <main className={`page-content ${contentClassName}`}>{children}</main>
    </div>
  );
}

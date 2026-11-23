import type { ReactNode } from 'react';

/** The glass panel with its lit top edge and four glowing corner brackets. */
export function GlassCard({ children }: { children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-edge" aria-hidden="true" />
      <div className="card-corner card-corner-tl" aria-hidden="true" />
      <div className="card-corner card-corner-tr" aria-hidden="true" />
      <div className="card-corner card-corner-bl" aria-hidden="true" />
      <div className="card-corner card-corner-br" aria-hidden="true" />
      {children}
    </section>
  );
}

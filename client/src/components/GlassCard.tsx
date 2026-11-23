import type { ReactNode } from 'react';

type GlassCardProps = {
  className?: string;
  /** The id of the heading that names this panel. */
  labelledBy?: string;
  children: ReactNode;
};

/** The glass panel with its lit top edge and four glowing corner brackets. */
export function GlassCard({ className = '', labelledBy, children }: GlassCardProps) {
  return (
    <section className={`card ${className}`} aria-labelledby={labelledBy}>
      <div className="card-edge" aria-hidden="true" />
      <div className="card-corner card-corner-tl" aria-hidden="true" />
      <div className="card-corner card-corner-tr" aria-hidden="true" />
      <div className="card-corner card-corner-bl" aria-hidden="true" />
      <div className="card-corner card-corner-br" aria-hidden="true" />
      {children}
    </section>
  );
}

import { useEffect, useState } from 'react';

/** The milliseconds left until `until`, refreshed a few times a second while it runs. */
export function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= until) clearInterval(timer);
    };
    const timer = setInterval(tick, 250);
    tick();
    return () => clearInterval(timer);
  }, [until]);

  return Math.max(0, until - now);
}

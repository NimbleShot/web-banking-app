import { useEffect, useState } from 'react';
import { COUNT_MS, countFrame } from './balanceCount';
import { motionIsReduced } from './reducedMotion';

const LEAD_MS = 200;
const SHOW_MS = 850;
const LAND_MS = 1200;
const FRAME_MS = 32;

export type CountPhase = 'lead' | 'show' | 'count' | 'land' | 'done';

/**
 * Plays a sent transfer on the balance: the amount appears, then it and the balance count together
 * until it is used up. Without a change, or with reduced motion, the balance is simply shown.
 */
export function useBalanceCount(balance: number | null, change: number | null) {
  const [phase, setPhase] = useState<CountPhase>('lead');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (balance === null || change === null || motionIsReduced()) return;
    let frame = 0;
    const timers = [
      setTimeout(() => setPhase('show'), LEAD_MS),
      setTimeout(() => {
        setPhase('count');
        const start = performance.now();
        let painted = start;
        const tick = (now: number) => {
          if (now - start >= COUNT_MS) {
            setPhase('land');
            timers.push(setTimeout(() => setPhase('done'), LAND_MS));
            return;
          }
          if (now - painted >= FRAME_MS) {
            painted = now;
            setElapsed(now - start);
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, LEAD_MS + SHOW_MS),
    ];
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
    };
  }, [balance, change]);

  // Worked out while rendering, so the first paint already shows the old balance.
  if (balance === null || change === null || phase === 'done' || motionIsReduced()) {
    return { phase: 'done' as CountPhase, shown: balance, remaining: 0 };
  }
  const { shown, remaining } = countFrame(balance, change, phase === 'land' ? COUNT_MS : elapsed);
  return { phase, shown: shown as number | null, remaining };
}

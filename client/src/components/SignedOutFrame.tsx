import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useMatches } from 'react-router';
import { noticeFrom } from '../auth/notices';
import { useCardMove } from '../motion/useCardMove';
import { Background } from './Background';
import { GlassCard } from './GlassCard';
import { Header } from './Header';
import { Hero } from './Hero';
import { Notice } from './Notice';

/** Set on each signed-out route. The step's order sets the side a new form slides in from. */
export type FrameScreen = { step: number; label: string };

/** Long enough for the hero to fade out with its notice still in place. */
const NOTICE_HOLD_MS = 800;

export type FrameContext = {
  /** Removes the login page's notice once the user tries to sign in. */
  dismissNotice: () => void;
};

/**
 * What stays on screen across the signed-out screens: the background, header, hero and card.
 * Only the form inside the card changes, so the card can slide and reshape between them.
 */
export function SignedOutFrame() {
  const { state, key } = useLocation();
  // From the matched route, because the router also accepts addresses like /Login/.
  const { step, label } = useMatches().at(-1)?.handle as FrameScreen;
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const onLogin = step === 0;
  const notice = onLogin && dismissedKey !== key ? noticeFrom(state) : null;

  const [lastNotice, setLastNotice] = useState(notice);
  if (onLogin && lastNotice !== notice) setLastNotice(notice);
  useEffect(() => {
    if (onLogin || !lastNotice) return;
    const timer = setTimeout(() => setLastNotice(null), NOTICE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [onLogin, lastNotice]);
  const shownNotice = onLogin ? notice : lastNotice;

  useCardMove(step, stageRef, panelRef);

  const context = useMemo<FrameContext>(
    () => ({ dismissNotice: () => setDismissedKey(key) }),
    [key],
  );

  return (
    <div className="page">
      <Background centered={!onLogin} />
      <Header label={label} />
      <main className={`page-content frame ${onLogin ? '' : 'frame-centered'}`}>
        <Hero
          folded={!onLogin}
          notice={shownNotice && <Notice title={shownNotice.title} body={shownNotice.body} />}
        />
        <GlassCard>
          <div ref={stageRef} className="card-stage">
            <div ref={panelRef} className="card-panel">
              <Outlet context={context} />
            </div>
          </div>
        </GlassCard>
      </main>
    </div>
  );
}

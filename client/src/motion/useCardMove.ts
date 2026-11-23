import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const EASE_MOVE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SHIFT_PX = 36;

const motionIsReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Plays one screen change inside the card: its height runs from the old form's to the new one's,
 * and the new form fades in from the side it sits on. The animations hold no style afterwards, so
 * the card goes back to following its content, and an error that grows a form still grows the card.
 */
export function useCardMove(
  step: number,
  stageRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
) {
  const lastStep = useRef(step);
  const settledHeight = useRef(0);
  const playing = useRef<Animation[]>([]);

  // A ResizeObserver answers after the commit, so during one this still holds the old form's height.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    settledHeight.current = panel.offsetHeight;
    const observer = new ResizeObserver(() => {
      settledHeight.current = panel.offsetHeight;
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef]);

  useLayoutEffect(() => {
    const previous = lastStep.current;
    const stage = stageRef.current;
    const panel = panelRef.current;
    if (previous === step || !stage || !panel) return;
    lastStep.current = step;

    // Mid-move the stage is at its animated height, which is where the next move has to start.
    const from = playing.current.length
      ? stage.getBoundingClientRect().height
      : settledHeight.current;
    const to = panel.offsetHeight;
    for (const animation of playing.current) animation.cancel();
    playing.current = [];

    // No earlier height means a redirect while loading: nothing was on screen to move from.
    if (from === 0) return;
    if (!panel.contains(document.activeElement)) {
      panel.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true });
    }
    if (motionIsReduced()) return;

    const side = step > previous ? SHIFT_PX : -SHIFT_PX;
    const fade = panel.animate(
      { opacity: [0, 1] },
      { duration: 400, delay: 80, easing: 'ease', fill: 'backwards' },
    );
    const slide = panel.animate(
      { transform: [`translateX(${side}px)`, 'translateX(0)'] },
      { duration: 600, delay: 120, easing: EASE_MOVE, fill: 'backwards' },
    );
    playing.current = [fade, slide];

    if (from !== to) {
      stage.classList.add('card-stage-moving');
      const reshape = stage.animate(
        { height: [`${from}px`, `${to}px`] },
        { duration: 600, easing: EASE_MOVE },
      );
      reshape.onfinish = reshape.oncancel = () => {
        if (stage.getAnimations().length === 0) stage.classList.remove('card-stage-moving');
      };
      playing.current.push(reshape);
    }
    const started = playing.current;
    void Promise.allSettled(started.map((animation) => animation.finished)).then(() => {
      if (playing.current === started) playing.current = [];
    });
  }, [step, stageRef, panelRef]);

  useEffect(
    () => () => {
      for (const animation of playing.current) animation.cancel();
    },
    [],
  );
}

import { useEffect, useRef } from 'react';

/**
 * Whether the screen is still showing. An answer that arrives after the user went elsewhere must
 * not sign them in, move them or change what they now see.
 */
export function useOnScreen() {
  const onScreen = useRef(false);

  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  return onScreen;
}

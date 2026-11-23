import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { Failure } from '../api/client';
import { loginState } from './notices';
import { clearToken } from './session';
import { clearSignUpDraft } from './signUpDraft';

/**
 * For the signed-in screens. The returned function says whether a failure means the server no
 * longer accepts the token and, if so, signs the user out with a notice. Any other 401 is not a
 * session ending: a wrong password or code stays on its own screen.
 */
export function useSessionEnd() {
  const navigate = useNavigate();
  const onScreen = useRef(false);

  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  return useCallback(
    (failure: Failure): boolean => {
      if (failure.kind !== 'problem' || failure.status !== 401) return false;
      if (failure.code !== 'UNAUTHORIZED') return false;
      // A late answer to a screen already left must not end the session the user has now.
      if (onScreen.current) {
        clearToken();
        clearSignUpDraft();
        void navigate('/login', { replace: true, state: loginState('sessionEnded') });
      }
      return true;
    },
    [navigate],
  );
}

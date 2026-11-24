import { useEffect } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router';
import { readToken } from './session';

/** The layout route around every signed-in screen. */
export function RequireSession() {
  const navigate = useNavigate();

  // The browser can restore a page from its back-forward cache without running any of its code,
  // which would show a signed-in screen again after sign-out.
  useEffect(() => {
    const recheck = (event: PageTransitionEvent) => {
      if (event.persisted && !readToken()) void navigate('/login', { replace: true });
    };
    window.addEventListener('pageshow', recheck);
    return () => window.removeEventListener('pageshow', recheck);
  }, [navigate]);

  return readToken() ? <Outlet /> : <Navigate to="/login" replace />;
}

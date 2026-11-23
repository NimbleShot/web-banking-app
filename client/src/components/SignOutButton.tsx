import { useNavigate } from 'react-router';
import { loginState } from '../auth/notices';
import { clearToken } from '../auth/session';
import { clearSignUpDraft } from '../auth/signUpDraft';
import { SignOutIcon } from './icons';

export function SignOutButton() {
  const navigate = useNavigate();

  function signOut() {
    // There is no logout call: the session ends when the browser forgets the token.
    clearToken();
    clearSignUpDraft();
    void navigate('/login', { replace: true, state: loginState('signedOut') });
  }

  return (
    <button type="button" className="button-ghost" onClick={signOut}>
      Sign out
      <SignOutIcon />
    </button>
  );
}

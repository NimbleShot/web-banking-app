import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireSession } from './auth/RequireSession';
import { Login } from './screens/Login';
import { ScreenStub } from './screens/ScreenStub';
import { SignUp } from './screens/SignUp';
import { Verify } from './screens/Verify';

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/login" replace /> },
  { path: '/login', element: <Login /> },
  { path: '/signup', element: <SignUp /> },
  { path: '/verify', element: <Verify /> },
  {
    path: '/forgot',
    element: (
      <ScreenStub
        title="Forgot your password?"
        label="PASSWORD RESET"
        eyebrow="STEP 01 / 02"
        lead="Enter your account's email. If it's registered, we'll send a 6-digit code to reset your password."
      />
    ),
  },
  {
    path: '/reset',
    element: (
      <ScreenStub
        title="Set a new password"
        label="PASSWORD RESET"
        eyebrow="STEP 02 / 02"
        lead="If an account uses this email, we sent it a 6-digit code. It works for 10 minutes."
      />
    ),
  },
  {
    element: <RequireSession />,
    children: [
      {
        path: '/dashboard',
        element: <ScreenStub signedIn title="Your account" eyebrow="YOUR BALANCE" lead="" />,
      },
      {
        path: '/transfer',
        element: <ScreenStub signedIn title="Send money" eyebrow="NEW TRANSFER" lead="" />,
      },
    ],
  },
  { path: '*', element: <Navigate to="/login" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}

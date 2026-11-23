import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireSession } from './auth/RequireSession';
import { SignedOutFrame, type FrameScreen } from './components/SignedOutFrame';
import { Dashboard } from './screens/Dashboard';
import { Forgot } from './screens/Forgot';
import { Login } from './screens/Login';
import { Reset } from './screens/Reset';
import { SignUp } from './screens/SignUp';
import { Transfer } from './screens/Transfer';
import { Verify } from './screens/Verify';

const screen = (step: number, label: string): FrameScreen => ({ step, label });

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/login" replace /> },
  {
    element: <SignedOutFrame />,
    children: [
      { path: '/login', element: <Login />, handle: screen(0, 'SECURE SIGN-IN') },
      { path: '/signup', element: <SignUp />, handle: screen(1, 'SECURE SIGN-UP') },
      { path: '/verify', element: <Verify />, handle: screen(2, 'EMAIL CHECK') },
      { path: '/forgot', element: <Forgot />, handle: screen(3, 'PASSWORD RESET') },
      { path: '/reset', element: <Reset />, handle: screen(4, 'PASSWORD RESET') },
    ],
  },
  {
    element: <RequireSession />,
    children: [
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/transfer', element: <Transfer /> },
    ],
  },
  { path: '*', element: <Navigate to="/login" replace /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}

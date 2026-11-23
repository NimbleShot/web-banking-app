import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { RequireSession } from './auth/RequireSession';
import { Dashboard } from './screens/Dashboard';
import { Forgot } from './screens/Forgot';
import { Login } from './screens/Login';
import { Reset } from './screens/Reset';
import { ScreenStub } from './screens/ScreenStub';
import { SignUp } from './screens/SignUp';
import { Verify } from './screens/Verify';

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/login" replace /> },
  { path: '/login', element: <Login /> },
  { path: '/signup', element: <SignUp /> },
  { path: '/verify', element: <Verify /> },
  { path: '/forgot', element: <Forgot /> },
  { path: '/reset', element: <Reset /> },
  {
    element: <RequireSession />,
    children: [
      { path: '/dashboard', element: <Dashboard /> },
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

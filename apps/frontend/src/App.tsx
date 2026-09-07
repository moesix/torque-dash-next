import { Suspense } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routerConfig } from '@/app/router';

// App defines the router instance and hands it to RouterProvider.
// QueryClientProvider is supplied by main.tsx (outer wrapper).
const router = createBrowserRouter(routerConfig);

export default function App() {
  return (
    // Suspense boundary for the React.lazy route elements in router.tsx. The
    // fallback shows only while an async route chunk (session/dashboard/
    // settings/register) is being fetched; /login never suspends.
    <Suspense
      fallback={
        <div className="flex items-center justify-center p-8 text-sm text-gray-500 dark:text-[var(--text-muted)]">
          Loading…
        </div>
      }
    >
      <RouterProvider router={router} />
    </Suspense>
  );
}

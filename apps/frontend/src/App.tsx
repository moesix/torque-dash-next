import { Suspense } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routerConfig } from '@/app/router';
import Skeleton from '@/components/ui/Skeleton';

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
        // Neutral pulse blocks — no text "Loading…" flicker; mirrors the
        // app's surface tokens. Nothing interactive here, so it's inert.
        <div className="w-full max-w-6xl space-y-4 p-4" aria-busy="true">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <RouterProvider router={router} />
    </Suspense>
  );
}

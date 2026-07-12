import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { routerConfig } from '@/app/router';

// App defines the router instance and hands it to RouterProvider.
// QueryClientProvider is supplied by main.tsx (outer wrapper).
const router = createBrowserRouter(routerConfig);

export default function App() {
  return <RouterProvider router={router} />;
}

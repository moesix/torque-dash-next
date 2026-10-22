import { Link } from 'react-router';

/**
 * Styled catch-all for unmatched routes. Previously the router fell through
 * to <Login/>, which silently "logged out" a signed-in user who fat-fingered
 * a URL. Sentence-case, surface-tokened, links back to Sessions.
 */
export default function NotFound() {
  return (
    <div className="card mx-auto mt-8 max-w-md text-center">
      <p className="font-mono text-xs uppercase tracking-wide text-fg-muted">
        HTTP 404
      </p>
      <h1 className="mt-1 text-xl font-semibold text-fg font-display">
        Page not found
      </h1>
      <p className="mt-2 text-sm text-fg-secondary">
        The page you opened doesn&rsquo;t exist. It may have been moved, or the
        link may be mistyped.
      </p>
      <Link
        to="/"
        className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink shadow-xs transition hover:bg-accent-hover"
      >
        ← Back to Sessions
      </Link>
    </div>
  );
}

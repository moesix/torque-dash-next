/**
 * Shared brand chrome for the app shell and auth pages.
 *
 * Centralises the GitHub octocat path, the external GitHub link and the
 * mobile-only auth logo block — previously duplicated byte-for-byte across
 * AppShell/MobileDrawer (GITHUB_PATH + link) and Login/Register (logo block).
 * The eventual owner-supplied logo SVG swap stays a single-file change in
 * `public/brand/`; this module just makes the mark's consumers explicit.
 */

/** GitHub octocat mark — standard filled path (Simple Icons convention). */
export const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

/** Repository URL — external origin, so the link is a plain anchor
 *  (target=_blank), never an SPA route Link. */
const GITHUB_HREF = 'https://github.com/moesix/torque-dash-next/';

interface GitHubLinkProps {
  /** Optional click handler — the mobile drawer closes itself on nav. */
  onClick?: () => void;
  /** Extra classes merged onto the default anchor styling. */
  className?: string;
}

/** External GitHub link used in the app chrome (sidebar + drawer). */
export function GitHubLink({ onClick, className = '' }: GitHubLinkProps) {
  return (
    <a
      href={GITHUB_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GitHub repository (opens in a new tab)"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-3 py-2 font-medium text-gray-600 hover:bg-gray-100 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)]${
        className ? ` ${className}` : ''
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
        <path d={GITHUB_PATH} />
      </svg>
      GitHub
    </a>
  );
}

/** Mobile-only logo block for the auth pages (left branding panel is hidden
 *  below md, so the wordmark is re-shown above the form). */
export function MobileLogo() {
  return (
    <div className="mb-8 text-center lg:hidden">
      <img src="/brand/logo.svg" alt="" loading="eager" className="mx-auto mb-4 h-12 w-12 rounded-xl" />
      <h1
        className="text-2xl font-bold text-gray-900 dark:text-white"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        TorqueDash-Next
      </h1>
    </div>
  );
}

import type { ReactNode } from 'react';

interface BrandFeature {
  title: string;
  description: string;
  icon: ReactNode;
}

/**
 * Shared left branding panel for the Login/Register split-screen: gradient
 * background, mark, product name, tagline, and the five product differentiators.
 * Rendered hidden below the `lg` breakpoint (the right panel carries a compact
 * logo block on mobile).
 */
const FEATURES: BrandFeature[] = [
  {
    title: 'Telemetry Replay',
    description:
      'Scrub frame-by-frame through every drive with synced charts, gauges and GPS track.',
    icon: (
      <>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </>
    ),
  },
  {
    title: 'AI Session Analysis',
    description:
      "Run a full diagnostic read of each trip; gaps and backfills are labeled so the model doesn't guess.",
    icon: (
      <>
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </>
    ),
  },
  {
    title: 'Multi-Vehicle Garage',
    description:
      'Assign sessions to vehicles and keep per-car history across every metric.',
    icon: (
      <>
        <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
        <circle cx="7" cy="17" r="2" />
        <path d="M9 17h6" />
        <circle cx="17" cy="17" r="2" />
      </>
    ),
  },
  {
    title: 'Pre-built Diagnostics',
    description:
      'Fuel trims, O2/AFR, coolant, boost & throttle panels rendered automatically when the PIDs exist.',
    icon: (
      <>
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </>
    ),
  },
  {
    title: 'Export & Reports',
    description:
      'One-click CSV of raw frames, markdown of AI analyses, print-ready session reports.',
    icon: (
      <>
        <path d="M12 15V3" />
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
      </>
    ),
  },
];

export default function AuthBranding() {
  return (
    <div className="hidden w-1/2 items-center justify-center bg-gradient-to-br from-teal-600 to-teal-800 p-12 lg:flex">
      <div className="max-w-md">
        <div className="text-center">
          <img
            src="/brand/logo.svg"
            alt=""
            loading="eager"
            className="mx-auto mb-6 h-16 w-16 rounded-2xl"
          />
          <h1
            className="text-3xl font-bold text-white"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            TorqueDash-Next
          </h1>
          <p className="mt-3 text-lg text-teal-100">
            Real-time vehicle telemetry replay and analysis.
          </p>
        </div>

        <ul role="list" className="mt-10 space-y-5 text-left">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
                className="mt-0.5 h-6 w-6 shrink-0 text-teal-200"
              >
                {f.icon}
              </svg>
              <div>
                <div className="text-sm font-semibold text-white">{f.title}</div>
                <p className="mt-0.5 text-sm leading-relaxed text-teal-100/90">
                  {f.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

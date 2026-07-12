import type { Config } from 'tailwindcss';

// Tremor v3 requires its color/boxShadow/radius/fontSize design tokens to be
// present in the Tailwind theme, and the content glob must cover the library's
// prebuilt components so their utility classes are generated.
const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@tremor/react/dist/**/*.{js,ts,jsx,tsx}',
    './node_modules/react-leaflet/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    transparent: 'transparent',
    current: 'currentColor',
    extend: {
      colors: {
        tremor: {
          brand: {
            faint: '#eff6ff',
            muted: '#bfdbfe',
            subtle: '#60a5fa',
            DEFAULT: '#3b82f6',
            emphasis: '#1d4ed8',
            inverted: '#ffffff',
          },
          background: {
            muted: '#f9fafb',
            subtle: '#f3f4f6',
            DEFAULT: '#ffffff',
            emphasis: '#374151',
          },
          border: { DEFAULT: '#e5e7eb' },
          ring: { DEFAULT: '#e5e7eb' },
          content: {
            subtle: '#9ca3af',
            DEFAULT: '#6b7280',
            emphasis: '#374151',
            strong: '#111827',
            inverted: '#ffffff',
          },
        },
        'dark-tremor': {
          brand: {
            faint: '#0B1229',
            muted: '#172554',
            subtle: '#1e40af',
            DEFAULT: '#3b82f6',
            emphasis: '#60a5fa',
            inverted: '#030712',
          },
          background: {
            muted: '#131A2B',
            subtle: '#1f2937',
            DEFAULT: '#111827',
            emphasis: '#d1d5db',
          },
          border: { DEFAULT: '#1f2937' },
          ring: { DEFAULT: '#1f2937' },
          content: {
            subtle: '#4b5563',
            DEFAULT: '#6b7280',
            emphasis: '#e5e7eb',
            strong: '#f9fafb',
            inverted: '#000000',
          },
        },
      },
      boxShadow: {
        'tremor-input': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'tremor-card':
          '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        'tremor-dropdown':
          '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        'dark-tremor-input': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'dark-tremor-card':
          '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        'dark-tremor-dropdown':
          '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
      },
      borderRadius: {
        'tremor-small': '0.375rem',
        'tremor-default': '0.5rem',
        'tremor-full': '9999px',
      },
      fontSize: {
        'tremor-label': ['0.75rem', { lineHeight: '1rem' }],
        'tremor-default': ['0.875rem', { lineHeight: '1.25rem' }],
        'tremor-title': ['1.125rem', { lineHeight: '1.75rem' }],
        'tremor-metric': ['1.875rem', { lineHeight: '2.25rem' }],
      },
    },
  },
  safelist: [
    {
      pattern:
        /^(bg|text|ring|stroke|border)-(tremor|dark-tremor)-(brand|background|border|ring|content)-([a-z]+)$/,
      variants: ['hover', 'ui-selected'],
    },
    {
      pattern: /^(bg|text|ring|stroke|border)-(tremor|dark-tremor)-([a-z]+)$/,
      variants: ['hover', 'ui-selected'],
    },
  ],
  plugins: [],
};

export default config;

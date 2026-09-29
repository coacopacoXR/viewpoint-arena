// Tailwind compiled at build time. It used to come from cdn.tailwindcss.com,
// Tailwind's Play CDN, which builds styles in every visitor's browser, is not
// meant for production, and leaves the app unstyled on a network without
// internet access (self-hosted installs). Same major line (3.4) and default
// theme as the CDN served, so output is unchanged.
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './store.ts',
    './types.ts',
    './components/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};

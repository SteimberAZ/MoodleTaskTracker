import type { Metadata, Viewport } from 'next';
import { Manrope, Syne } from 'next/font/google';
import './globals.css';
import './skeleton.css';
import { SiteHeader } from '@/components/Brand';
import PwaClient from '@/components/PwaClient';

const syne = Syne({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-syne',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mineral tareas',
  description: 'Recordatorios personales con avisos periódicos',
  robots: { index: false, follow: false },
  applicationName: 'mineral tareas',
  // Declaring `icons` replaces the automatic link of app/icon.svg, so the SVG favicon is listed here too.
  // iOS ignores SVG icons (it would show a letter), so it gets a real 180px PNG.
  icons: {
    icon: [
      // `?v=2` busts the browsers' long-lived favicon cache after the redesign; bump it when the mark changes.
      { url: '/icon.svg?v=3', type: 'image/svg+xml', sizes: 'any' },
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: 'mineral tareas', statusBarStyle: 'black-translucent' },
  // Next only emits the generic mobile-web-app-capable tag; Safari on iOS still reads the Apple one.
  other: { 'apple-mobile-web-app-capable': 'yes' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f2e9' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // data-scroll-behavior lets Next.js skip the smooth scroll on route changes (no scroll jump between tabs).
  return (
    <html lang="es" className={`${syne.variable} ${manrope.variable}`} data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main">Saltar al contenido</a>
        <SiteHeader />
        <main id="main" className="container">{children}</main>
        <PwaClient />
      </body>
    </html>
  );
}

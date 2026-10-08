import type { Metadata, Viewport } from 'next';
import { Manrope, Syne } from 'next/font/google';
import './globals.css';
import { SiteHeader } from '@/components/Brand';

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
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: '#b0603c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${syne.variable} ${manrope.variable}`}>
      <body>
        <a className="skip-link" href="#main">Saltar al contenido</a>
        <SiteHeader />
        <main id="main" className="container">{children}</main>
      </body>
    </html>
  );
}

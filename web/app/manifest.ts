import type { MetadataRoute } from 'next';

/** Colors of the dark theme (see :root in globals.css): the installed app always opens dark. */
const BACKGROUND = '#000000';
const THEME = '#000000';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'mineral tareas',
    short_name: 'Tareas',
    description: 'Tareas de Moodle UTM con avisos en tu celular',
    lang: 'es',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: THEME,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      // Android 13+ themed icon: Android tints the alpha silhouette with the user's wallpaper colors.
      { src: '/icons/icon-monochrome-512.png', sizes: '512x512', type: 'image/png', purpose: 'monochrome' },
    ],
  };
}

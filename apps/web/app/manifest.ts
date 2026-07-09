import type { MetadataRoute } from 'next';

// Next.js's built-in manifest file convention — served at /manifest.webmanifest
// and linked automatically. Along with the service worker (public/sw.js) and
// HTTPS, this is what makes Chrome on Android offer "Install app" / "Add to
// Home Screen" for the site, turning /scan into a real installed app icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Als Inventory',
    short_name: 'Als Inventory',
    description: 'Scan and manage IT assets, online or offline.',
    start_url: '/scan',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    orientation: 'portrait',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}

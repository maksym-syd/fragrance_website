/**
 * Public address used in share links. Always the production domain, so links copied from
 * localhost, a Vercel preview, or the team-protected alias still work for friends.
 * Override with VITE_SITE_URL if the domain changes.
 */
export const SITE_URL = (
  (import.meta.env.VITE_SITE_URL as string | undefined) || 'https://fragrance-website-five.vercel.app'
).replace(/\/+$/, '');

export const roomLink = (code: string) => `${SITE_URL}/r/${code}`;

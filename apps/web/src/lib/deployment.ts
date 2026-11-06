/** Facts about where the app is running (D-062). Pure. */

/** The hosts 0G's Privy app ID accepts sign-ins from (on ports 3000, 3001 and 5173). */
export const isLocalhost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

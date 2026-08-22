/* Same-origin by default: the Node server serves this frontend itself.
   `npm run build` overwrites this with the deployed API origin. */
window.__CONFIG__ = { apiBase: '' };

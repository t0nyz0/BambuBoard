// OBS collections may contain browser sources intended for a different host.
// Resolve relative URLs but render only web sources in BambuBoard.
function parseBrowserSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    // Bundled OBS collections keep this placeholder so saved drafts can
    // still move between BambuBoard installations.
    const address = value.trim().replace(/^https?:\/\/<HOST>(?=\/)/i, window.location.origin);
    const url = new URL(address, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch (_) { return null; }
}

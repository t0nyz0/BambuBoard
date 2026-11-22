// OBS collections may contain browser sources intended for a different host.
// Resolve relative URLs but render only web sources in BambuBoard.
function parseBrowserSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch (_) { return null; }
}

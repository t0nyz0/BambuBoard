function sameOrigin(req) {
  const header = req.headers.origin;
  if (header === undefined) return true;
  try {
    const origin = new URL(header);
    if (header !== origin.origin || !['http:', 'https:'].includes(origin.protocol)) return false;
    if (origin.host === String(req.headers.host || '').toLowerCase()) return true;
    // Only the configured public origin can stand in for a rewritten Host.
    return !!process.env.BAMBUBOARD_PUBLIC_URL
      && origin.origin === new URL(process.env.BAMBUBOARD_PUBLIC_URL).origin;
  } catch (_) { return false; }
}

module.exports = { sameOrigin };

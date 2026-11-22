function publicTelemetry(snapshot) {
  const camera = snapshot?.print?.ipcam;
  if (!camera || !Object.hasOwn(camera, 'rtsp_url')) return snapshot;

  // Keep the legacy field usable as a status without publishing an endpoint,
  // which may contain credentials or a signed query.
  const endpoint = camera.rtsp_url;
  const state = typeof endpoint === 'string' && endpoint && endpoint !== 'disable' ? 'enable' : 'disable';
  if (state === endpoint) return snapshot;
  return { ...snapshot, print: { ...snapshot.print, ipcam: { ...camera, rtsp_url: state } } };
}

module.exports = { publicTelemetry };

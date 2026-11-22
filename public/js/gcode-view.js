// The renderer and Scene Editor share the settings used in widget URLs.
(function (root) {
  const presets = Object.freeze({
    angled: { azimuth: 306, elevation: 30 },
    top: { azimuth: 0, elevation: 90 },
    front: { azimuth: 0, elevation: 10 },
    side: { azimuth: 90, elevation: 10 },
  });
  const defaultView = 'angled';
  const defaultZoom = 100;
  function normalize(view, value) {
    const zoom = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return {
      view: typeof view === 'string' && Object.hasOwn(presets, view) ? view : defaultView,
      zoom: Number.isFinite(zoom) ? Math.max(50, Math.min(200, Math.round(zoom))) : defaultZoom,
    };
  }
  root.BBGcodeView = { presets, defaultView, defaultZoom, normalize };
})(globalThis);

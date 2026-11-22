// Keep browser and server limits in sync for the same toolpath.
(function (root) {
  const limits = Object.freeze({ archiveMiB: 128, toolpathMiB: 250, transferIdleMs: 30000, transferPollMs: 1000 });
  if (typeof module === 'object' && module.exports) module.exports = limits;
  else root.BBGcodeLimits = limits;
})(globalThis);

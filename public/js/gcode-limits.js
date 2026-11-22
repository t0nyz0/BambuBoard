// Keep browser and server limits in sync for the same toolpath.
(function (root) {
  const limits = Object.freeze({ archiveMiB: 128, toolpathMiB: 80, toolpathLines: 3000000 });
  if (typeof module === 'object' && module.exports) module.exports = limits;
  else root.BBGcodeLimits = limits;
})(globalThis);

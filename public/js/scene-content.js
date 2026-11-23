// Shared browser presentation for bitmap and text sources in Layout and Live.
(function () {
  const imageIds = ['image_source', 'image_source_v2'];
  const textIds = ['text_ft2_source', 'text_gdiplus', 'text_gdiplus_v2'];

  function looksLikeImageUrl(url) {
    if (!url) return false;
    const path = url.split(/[?#]/)[0].toLowerCase();
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(path)
      || /^https?:\/\/[^/]*\.s3[.-]?[a-z0-9-]*\.amazonaws\.com\/[^/?#]+$/.test(url);
  }

  function isImage(source) {
    return imageIds.includes(source?.id)
      || (source?.id === 'browser_source' && looksLikeImageUrl(parseBrowserSourceUrl(source.settings?.url)?.href));
  }

  function hasBounds(item) {
    return !!item.bounds_type && item.bounds?.x > 0 && item.bounds?.y > 0;
  }

  function imageAnchorSupported(item, source) {
    return isImage(source) && hasBounds(item) && [2, 3, 6].includes(Number(item.bounds_type));
  }

  function renderImage(image, item, source) {
    image.style.imageRendering = item.scale_filter === 'point' ? 'pixelated' : '';
    const bounds = hasBounds(item) ? Number(item.bounds_type) : 0;
    image.style.objectFit = ({ 1: 'fill', 3: 'cover', 6: 'scale-down' })[bounds] || 'contain';
    const align = imageAnchorSupported(item, source) ? item.bounds_align : 0;
    const x = align & 1 ? 'left' : align & 2 ? 'right' : 'center';
    const y = align & 4 ? 'top' : align & 8 ? 'bottom' : 'center';
    image.style.objectPosition = `${x} ${y}`;
  }

  function renderText(settings, color) {
    const text = document.createElement('div');
    const font = settings.font || {};
    text.textContent = settings.text || '';
    text.style.fontSize = `${(Number(font.size) || 24) * 1.5}px`;
    text.style.fontFamily = font.face ? `"${font.face}", sans-serif` : 'sans-serif';
    text.style.color = color(settings.color1 ?? settings.color ?? 0xFFFFFFFF);
    text.style.padding = '4px 8px';
    text.style.whiteSpace = 'pre';
    return text;
  }

  window.BBSceneContent = { looksLikeImageUrl, isImage, imageAnchorSupported, renderImage, renderText, isText: source => textIds.includes(source?.id) };
})();

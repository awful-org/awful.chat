/**
 * How tall the part of the page that can be seen is, in layout pixels: the
 * window, less a software keyboard when one is up.
 *
 * visualViewport.height alone is not that. It shrinks for a keyboard, and it
 * shrinks for zoom just the same - a pinch, a phone zooming in to a focused
 * field, a "desktop site" shown enlarged - and an app that takes zoom for a
 * keyboard folds itself into the top of the screen. Width tells the two apart:
 * a keyboard leaves it alone, zoom changes both by the same factor.
 */
export function visibleHeight(): number {
  const vv = window.visualViewport;
  return vv ? vv.height * pageZoom() : window.innerHeight;
}

/**
 * How far the page is zoomed in on its layout: 1 when it is not, and when it is
 * zoomed out past it (something wider than the screen), where what is seen is
 * taller than the layout and is all there to be filled.
 */
function pageZoom(): number {
  const vv = window.visualViewport;
  const layoutWidth = document.documentElement.clientWidth;
  if (!vv || !(vv.width > 0) || !(layoutWidth > 0)) return 1;
  const zoom = layoutWidth / vv.width;
  // Fractional widths round differently; that is not a zoom.
  return zoom < 1.01 ? 1 : zoom;
}

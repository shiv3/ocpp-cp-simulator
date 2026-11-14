// jsdom has no Web Animations API; @ui-sdk/core calls `el.getAnimations()` when
// a popup closes (presence.js) and throws an uncaught exception without it.
// A real browser (and Tauri's WebView) has it; only the test env needs a shim.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    value: () => [],
    configurable: true,
  });
}

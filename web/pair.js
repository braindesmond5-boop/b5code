// The pairing page's only script: the service worker, so B5 Code can be installed
// as an app from any browser (Chrome, Samsung Internet) before it's paired.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});

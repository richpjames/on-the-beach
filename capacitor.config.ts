import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the hosted On The Beach web app in a thin native iOS shell.
// The shell exists primarily to host a native Share Extension (see
// `native/ShareExtension/`) so the app appears in the iOS share sheet — something a
// pure web app / PWA cannot do, because iOS Safari does not implement the Web
// Share Target API.
//
// `server.url` points the shell's WKWebView at the live deployment, so the app
// itself is always the current production build with no separate mobile bundle
// to maintain. Override `OTB_APP_URL` at build time to target a staging origin.
const config: CapacitorConfig = {
  appId: "es.ricojam.onthebeach",
  appName: "On The Beach",
  // webDir is unused when server.url is set, but Capacitor requires it to exist.
  webDir: "build/client",
  server: {
    url: process.env.OTB_APP_URL ?? "https://onthebeach.ricojam.es",
    cleartext: false,
  },
  ios: {
    // Match the app's dark retro chrome so the status bar area doesn't flash white.
    backgroundColor: "#000000",
  },
};

export default config;

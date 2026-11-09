import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
// Bundled by Vite (no CDN): the console also runs offline in the daemon image
// and the desktop app.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import { DataProvider } from "./data/providers/DataProvider";
import { i18nReady } from "./i18n";
import { initErrorReporting } from "./lib/errorReporting";

// Wait for the saved language (English is bundled, so this is immediate for
// the default) so the first paint is already translated, and for the opt-in
// error reporting (#794; immediate without a VITE_ERROR_REPORTER).
void Promise.all([
  i18nReady.catch(() => undefined), // a failed chunk load falls back to English
  initErrorReporting(), // never rejects: a failure leaves reporting off
]).then(([, rootErrorHooks]) =>
  ReactDOM.createRoot(document.getElementById("root")!, rootErrorHooks).render(
    <React.StrictMode>
      <DataProvider>
        <App />
      </DataProvider>
    </React.StrictMode>,
  ),
);

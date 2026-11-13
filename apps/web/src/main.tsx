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
import { awaitI18nFirstPaint } from "./i18n/firstPaint";
import { initErrorReporting } from "./lib/errorReporting";

// Wait for the saved language (English is bundled, so this is immediate for
// the default) so the first paint is already translated, bounded by
// I18N_FIRST_PAINT_WAIT_MS (#899: past it English shows and the language
// switches when its chunk arrives), and for the opt-in
// error reporting (#794; immediate without a VITE_ERROR_REPORTER, bounded by
// ERROR_REPORTER_WAIT_MS with one, after which the adapter loads late).
void Promise.all([
  awaitI18nFirstPaint(i18nReady), // never rejects: a failed load stays English
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

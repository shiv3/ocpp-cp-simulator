// App.tsx
import React from "react";
import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Footer from "./components/Footer.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";
import { DarkModeProvider } from "./contexts/DarkModeContext.tsx";
import ConsoleApp from "./console/ConsoleApp.tsx";

// The classic UI, mounted under /v2. Exported (not just used locally) so dom
// tests can mount the real V2 route nesting under their own MemoryRouter —
// see src/console/v2-settings-nav.dom.test.tsx, which proves Settings.tsx's
// relative navigate("..") resolves to `/v2` (not `/`) when nested here.
export const V2App: React.FC = () => {
  return (
    <DarkModeProvider>
      <div className="min-h-screen flex flex-col bg-gray-100 dark:bg-gray-900 transition-colors">
        <Navbar />
        <div className="p-4 flex-1">
          <Routes>
            <Route path="/" element={<TopPage />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
        <Footer />
      </div>
    </DarkModeProvider>
  );
};

/**
 * Old `/v3/...` bookmarks (the console was served there before #411) land on
 * the same console route, keeping the query string and hash. A router
 * `<Navigate>` (not `window.location`) so the GitHub Pages basename
 * (`VITE_BASE_URL`) is applied.
 */
const LegacyConsoleRedirect: React.FC = () => {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.replace(/^\/v3(?=\/|$)/, "");
  return <Navigate to={{ pathname: rest || "/", search, hash }} replace />;
};

/**
 * Top-level route tree, exported without a `<Router>` so dom tests can mount
 * the real routing under their own `<MemoryRouter>` (see
 * src/AppRoutes.dom.test.tsx).
 */
export const AppRoutes: React.FC = () => (
  <Routes>
    {/* The legacy v1 UI was removed (#411; last shipped at the
        `legacy-v1-final` tag). Old bookmarks land on the root instead of an
        empty page. The daemon's /v1/* HTTP paths (health endpoint, removed
        REST API) are server-side and never reach this router. */}
    <Route path="/v1/*" element={<Navigate to="/" replace />} />

    <Route path="/v3/*" element={<LegacyConsoleRedirect />} />

    {/* The classic UI stays reachable under /v2 while the features it still
        has alone move to the web console (#411). */}
    <Route path="/v2/*" element={<V2App />} />

    {/* The web console, at the root. */}
    <Route
      path="/*"
      element={
        <DarkModeProvider>
          <ConsoleApp />
        </DarkModeProvider>
      }
    />
  </Routes>
);

const App: React.FC = () => {
  return (
    <Router basename={import.meta.env.VITE_BASE_URL}>
      <AppRoutes />
    </Router>
  );
};

export default App;

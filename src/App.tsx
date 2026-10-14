// App.tsx
import React from "react";
import {
  BrowserRouter as Router,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { DarkModeProvider } from "./contexts/DarkModeContext.tsx";
import ConsoleApp from "./console/ConsoleApp.tsx";

/**
 * Old bookmarks under a retired prefix land on the same console route,
 * keeping the query string and hash: `/v3/...` (where the console was served
 * before #411) and `/v2/...` (the classic UI, retired by #426). A router
 * `<Navigate>` (not `window.location`) so the GitHub Pages basename
 * (`VITE_BASE_URL`) is applied.
 */
const LegacyPrefixRedirect: React.FC<{ prefix: "/v2" | "/v3" }> = ({
  prefix,
}) => {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.slice(prefix.length).replace(/^\/$/, "");
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

    <Route path="/v2/*" element={<LegacyPrefixRedirect prefix="/v2" />} />
    <Route path="/v3/*" element={<LegacyPrefixRedirect prefix="/v3" />} />

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

// App.tsx
import React from "react";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Footer from "./components/Footer.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";
import { DarkModeProvider } from "./contexts/DarkModeContext.tsx";
import V1App from "./v1/V1App.tsx";
import ConsoleApp from "./console/ConsoleApp.tsx";

// Exported (not just used locally) so dom tests can mount the real V2 route
// nesting under their own MemoryRouter — see
// src/console/v2-settings-nav.dom.test.tsx, which proves Settings.tsx's
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

const App: React.FC = () => {
  return (
    <Router basename={import.meta.env.VITE_BASE_URL}>
      <Routes>
        {/* V1 legacy routes - outside DarkModeProvider */}
        <Route path="/v1/*" element={<V1App />} />

        {/* V3 new console (redesign) - opt-in under /v3 */}
        <Route
          path="/v3/*"
          element={
            <DarkModeProvider>
              <ConsoleApp />
            </DarkModeProvider>
          }
        />

        {/* /v2 - backward-compatible alias for the classic UI (old bookmarks
            and deep links keep working). */}
        <Route path="/v2/*" element={<V2App />} />

        {/* Classic UI is the default again, served at the root. Anything not
            claimed by /v1, /v2, or /v3 lands here. */}
        <Route path="/*" element={<V2App />} />
      </Routes>
    </Router>
  );
};

export default App;

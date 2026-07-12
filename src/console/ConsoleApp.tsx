import React from "react";
import { Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import DashboardPage from "./pages/DashboardPage";
import CpDetailPage from "./pages/CpDetailPage";
import ScenarioLibraryPage from "./pages/ScenarioLibraryPage";
import ScenarioEditPage from "./pages/ScenarioEditPage";
import ScenarioRunPage from "./pages/ScenarioRunPage";
import LogsPage from "./pages/LogsPage";
import SettingsPage from "./pages/SettingsPage";

/**
 * Route tree for the new console. Exported without a top-level `<Router>`
 * so tests can mount it inside their own `<MemoryRouter>` (see
 * `src/console/test/harness.tsx`).
 */
export const ConsoleRoutes: React.FC = () => (
  <Routes>
    <Route element={<AppShell />}>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/cp/:cpId" element={<CpDetailPage />} />
      <Route path="/scenarios" element={<ScenarioLibraryPage />} />
      <Route path="/scenarios/edit" element={<ScenarioEditPage />} />
      <Route path="/scenarios/run" element={<ScenarioRunPage />} />
      <Route path="/logs" element={<LogsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Route>
  </Routes>
);

const ConsoleApp: React.FC = () => <ConsoleRoutes />;

export default ConsoleApp;

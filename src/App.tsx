// App.tsx
import React from "react";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";
import { DarkModeProvider } from "./contexts/DarkModeContext.tsx";
import V1App from "./v1/V1App.tsx";

const V2App: React.FC = () => {
  return (
    <DarkModeProvider>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 transition-colors">
        <Navbar />
        <div className="p-4">
          <Routes>
            <Route path="/" element={<TopPage />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
    </DarkModeProvider>
  );
};

const App: React.FC = () => {
  return (
    <Router basename={import.meta.env.VITE_BASE_URL}>
      <Routes>
        {/* V1 Routes - Outside DarkModeProvider */}
        <Route path="/v1/*" element={<V1App />} />

        {/* V2 Routes - With DarkModeProvider */}
        <Route path="/*" element={<V2App />} />
      </Routes>
    </Router>
  );
};

export default App;

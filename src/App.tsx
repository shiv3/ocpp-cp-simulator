// App.tsx
import React from "react";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";
import { DarkModeProvider } from "./contexts/DarkModeContext.tsx";

const App: React.FC = () => {
  return (
    <DarkModeProvider>
      <Router basename={import.meta.env.VITE_BASE_URL}>
        <div className="min-h-screen bg-gray-100 dark:bg-gray-900 transition-colors">
          <Navbar />
          <div className="p-4">
            <Routes>
              <Route path="/" element={<TopPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </div>
      </Router>
    </DarkModeProvider>
  );
};

export default App;

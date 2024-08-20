// App.tsx
import React from "react";
import {BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";

const App: React.FC = () => {


  return (
    <Router basename={import.meta.env.VITE_BASE_URL}>
      <div className="min-h-screen bg-gray-100">
        <Navbar />
        <div className="container mx-auto my-auto p-4">
          <Routes>
            <Route path="/" element={<TopPage />}  />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
};

export default App;

// V1App.tsx
import React, { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar.tsx";
import Settings from "./components/Settings.tsx";
import TopPage from "./components/TopPage.tsx";
import "./v1.css";

const V1App: React.FC = () => {
  useEffect(() => {
    // Remove dark class from html element when V1 is mounted
    const root = window.document.documentElement;
    const hadDarkClass = root.classList.contains('dark');
    root.classList.remove('dark');

    // Restore dark class when V1 is unmounted
    return () => {
      if (hadDarkClass) {
        root.classList.add('dark');
      }
    };
  }, []);

  return (
    <div className="v1-app min-h-screen bg-gray-100 text-gray-900">
      <Navbar />
      <div className="container mx-auto my-auto p-4">
        <Routes>
          <Route path="/" element={<TopPage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </div>
  );
};

export default V1App;

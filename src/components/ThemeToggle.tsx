import React from 'react';
import { HiMoon, HiSun } from 'react-icons/hi';
import { useDarkMode } from '../contexts/DarkModeContext';
import { Button, Dropdown } from 'flowbite-react';

const ThemeToggle: React.FC = () => {
  const { theme, setTheme, isDark } = useDarkMode();

  return (
    <Dropdown
      label=""
      dismissOnClick={true}
      renderTrigger={() => (
        <Button
          color="gray"
          size="sm"
          className="!p-2"
          aria-label="Toggle theme"
        >
          {isDark ? (
            <HiMoon className="h-5 w-5" />
          ) : (
            <HiSun className="h-5 w-5" />
          )}
        </Button>
      )}
    >
      <Dropdown.Item onClick={() => setTheme('light')}>
        <HiSun className="mr-2 h-4 w-4" />
        Light
        {theme === 'light' && <span className="ml-2">✓</span>}
      </Dropdown.Item>
      <Dropdown.Item onClick={() => setTheme('dark')}>
        <HiMoon className="mr-2 h-4 w-4" />
        Dark
        {theme === 'dark' && <span className="ml-2">✓</span>}
      </Dropdown.Item>
      <Dropdown.Item onClick={() => setTheme('system')}>
        <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        System
        {theme === 'system' && <span className="ml-2">✓</span>}
      </Dropdown.Item>
    </Dropdown>
  );
};

export default ThemeToggle;

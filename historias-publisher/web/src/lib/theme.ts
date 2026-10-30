import * as React from 'react';

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains('dark'));
  const toggle = React.useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle('dark', next);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next ? '#0d0e10' : '#f7f6f3');
      try {
        localStorage.setItem('hp-theme', next ? 'dark' : 'light');
      } catch {
        // sem armazenamento local: vale só nesta visita
      }
      return next;
    });
  }, []);
  return [dark, toggle];
}

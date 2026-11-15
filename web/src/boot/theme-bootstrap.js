// Fast theme bootstrap. Runs before the app bundle so the first paint already
// uses the host-selected color scheme. Fixed: honor "light" instead of always
// forcing the dark class.
(function () {
  'use strict';

  var theme = 'system';
  try {
    var params = new URLSearchParams(window.location.search);
    theme = params.get('hostTheme') || window.__AG_HOST_THEME__ || 'system';
  } catch (e) {
    theme = window.__AG_HOST_THEME__ || 'system';
  }
  if (theme === 'system') {
    var isDark;
    if (typeof window !== 'undefined' && window.Android && typeof window.Android.getTheme === 'function') {
      try {
        var t = window.Android.getTheme();
        if (t === 'dark' || t === 'light') isDark = (t === 'dark');
      } catch (e) {}
    }
    if (isDark === undefined && typeof window !== 'undefined' && window.__AG_RESOLVED_THEME__) {
      isDark = (window.__AG_RESOLVED_THEME__ === 'dark');
    }
    if (isDark === undefined) {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    theme = isDark ? 'dark' : 'light';
  } else {
    theme = theme === 'light' ? 'light' : 'dark';
  }

  document.documentElement.style.colorScheme = theme;
  document.documentElement.classList.add(theme);

  try {
    var isAmoled = false;
    if (typeof window !== 'undefined' && window.Android && typeof window.Android.isAmoled === 'function') {
      try { isAmoled = window.Android.isAmoled(); } catch (e) {}
    }
    if (!isAmoled && typeof localStorage !== 'undefined') {
      isAmoled = localStorage.getItem('jetski.amoled') === 'true' || localStorage.getItem('theme-preset-dark') === 'AMOLED Black';
    }
    if (isAmoled) {
      document.documentElement.classList.add('amoled-black');
      if (typeof window !== 'undefined' && window.Android && typeof window.Android.onVisualThemeChanged === 'function') {
        window.Android.onVisualThemeChanged('amoled');
      }
    }

    var style = document.createElement('style');
    style.id = 'amoled-theme-style';
    style.textContent = [
      'html.amoled-black.dark, html.amoled-black.dark body, html.amoled-black.dark #root, html.amoled-black.dark .theme-standalone {',
      '  --background: #000000 !important;',
      '  --sidebar: #000000 !important;',
      '  --sidebar-secondary: #060608 !important;',
      '  --sidebar-muted: #030304 !important;',
      '  --content: #000000 !important;',
      '  --card: #08080a !important;',
      '  --card-border: rgba(255, 255, 255, 0.08) !important;',
      '  --border: rgba(255, 255, 255, 0.08) !important;',
      '  --muted: #0c0d10 !important;',
      '  --muted-foreground: #a0a0a8 !important;',
      '  --secondary: #0f1013 !important;',
      '  background-color: #000000 !important;',
      '}',
      'html.amoled-black.dark .bg-background { background-color: #000000 !important; }',
      'html.amoled-black.dark .bg-card { background-color: #08080a !important; }',
      'html.amoled-black.dark header { background-color: #000000 !important; }',
      'html.amoled-black.dark [data-testid="conversation-message"] { background-color: transparent !important; }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
})();

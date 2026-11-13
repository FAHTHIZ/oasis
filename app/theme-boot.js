// Theme before first paint. A classic script in <head>, so the page never
// flashes the dark theme before main.mjs (a module, run after parsing) reads
// the saved setting and applies light. Mirrors applyTheme() in main.mjs.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('oasis.settings') || '{}') || {};
    var theme = saved.theme === 'dark' || saved.theme === 'light' ? saved.theme : 'system';
    var light = theme === 'light' || (theme === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    if (light) {
      document.documentElement.classList.add('light');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = '#F7F7F5';
    }
  } catch (e) { /* storage blocked: main.mjs applies the theme */ }
})();

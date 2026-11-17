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
// The side panel too: when it was open last time, its space is held from the
// first paint, so the chat column does not jump narrower once main.mjs opens
// it (main.mjs drops the class when it takes over). Mirrors toggleFiles().
(function () {
  try {
    // Never set yet: main.mjs opens it whenever a project is open, which is
    // nearly always, so hold the space then too.
    var files = localStorage.getItem('oasis.files');
    if (innerWidth < 1024 || files === '0') return;
    document.documentElement.classList.add('files-boot');
    var width = Number(localStorage.getItem('oasis.panelWidth'));
    if (width >= 280) document.documentElement.style.setProperty('--panel-w', Math.round(Math.min(width, Math.max(280, innerWidth * 0.6))) + 'px');
  } catch (e) { /* storage blocked */ }
})();

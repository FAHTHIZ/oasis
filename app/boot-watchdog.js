// Boot watchdog. A classic script that runs before the module graph: if
// main.mjs or anything it imports fails to load (a 404 from an `oasis web`
// started before these app files changed, a missing export, a syntax error),
// the browser fires an error and main.mjs never runs. Without this the page
// sat on "Connecting…" forever. main.mjs sets data-booted as its first
// statement; until then, any load error or 8 s of silence shows a message.
(function () {
  var root = document.documentElement;
  var shown = false;
  var timer = 0;

  function failedUrl(hint) {
    if (hint && !/\/main\.mjs$/.test(hint)) return hint;
    try {
      var entries = performance.getEntriesByType('resource');
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.responseStatus >= 400 && /\.(m?js|json)(\?|$)/.test(entry.name)) return entry.name;
      }
    } catch (e) { /* older browsers: no responseStatus */ }
    return hint || '';
  }

  function show(hint) {
    if (shown || root.dataset.booted) return;
    shown = true;
    clearTimeout(timer);
    var url = failedUrl(hint);
    var box = document.createElement('div');
    box.className = 'boot-failure';
    box.setAttribute('role', 'alert');
    var text = document.createElement('p');
    text.append('OASIS could not load part of the app' + (url ? ' (' + url.replace(location.origin, '') + ')' : '') + '. Restart ');
    var code = document.createElement('code');
    code.textContent = 'oasis web';
    text.append(code, ' — it is probably older than these app files.');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn primary';
    button.textContent = 'Reload';
    button.addEventListener('click', function () { location.reload(); });
    box.append(text, button);
    (document.body || root).append(box);
    button.focus();
  }

  // Module graph fetch failures fire 'error' on the <script type=module>
  // element (no bubbling, so listen in the capture phase); link/instantiate
  // and evaluation errors arrive as window ErrorEvents.
  window.addEventListener('error', function (event) {
    if (root.dataset.booted) return;
    var target = event.target;
    if (target && target.tagName === 'SCRIPT') show(target.src);
    else if (event instanceof ErrorEvent && /\.m?js(\?|$)/.test(event.filename || '')) {
      // "The requested module './core/x.mjs' does not provide an export named …"
      var named = /requested module ['"]([^'"]+)['"]/.exec(event.message || '');
      show(named ? named[1] + ' (' + event.message + ')' : event.filename);
    }
  }, true);
  timer = setTimeout(function () { show(''); }, 8000);
})();

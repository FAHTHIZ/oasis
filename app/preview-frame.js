// Live preview frame for the universal app. It is loaded in an iframe that is
// sandboxed without allow-same-origin, so the page being previewed cannot read
// the app's storage, keys or projects. The app sends the page with its local
// CSS and scripts already inlined (see core/preview.mjs); this frame writes it
// into the document. Each preview reloads this frame, so one write per load.
(function () {
  'use strict';
  window.addEventListener('message', function onMessage(event) {
    var data = event.data;
    if (event.source !== parent || !data || typeof data.html !== 'string') return;
    window.removeEventListener('message', onMessage);
    document.open();
    document.write(data.html);
    document.close();
  });
  // Echo which load this is, so the app never answers a page it replaced.
  var load = (/[?&]load=(\d+)/.exec(location.search) || [])[1] || '';
  parent.postMessage({ oasisPreview: 'ready', load: load }, '*');
})();

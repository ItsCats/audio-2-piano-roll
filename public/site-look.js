// The site's look (src/lib/siteLook.ts), switched on before the first paint so a light page never
// starts dark. Not in the Piano Studio, which keeps its own dark look (and its dark browser bar).
(function () {
  var studio = location.pathname.startsWith('/studio');
  if (!studio) document.documentElement.dataset.site = '';
  var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var media = metas[i].getAttribute('media') || '';
    metas[i].content = studio ? '#0b0b0f' : /dark/.test(media) || (!/light/.test(media) && dark) ? '#111110' : '#faf9f6';
  }
})();

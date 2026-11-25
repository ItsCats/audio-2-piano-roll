// The site's look (src/lib/siteLook.ts), switched on before the first paint so a light page never
// starts dark. Not in the Piano Studio, which keeps its own dark look.
if (!location.pathname.startsWith('/studio')) document.documentElement.dataset.site = '';

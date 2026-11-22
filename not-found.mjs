import { TRANS } from './translations.mjs';
import { SEO, notFoundLocaleFromPath } from './seo-content.mjs';

// 404 page only. The static 404.html is English for crawlers and no-JS readers; this external module (CSP: script-src 'self')
// moves text, lang, dir and links to the locale named by the first path segment.
const locale = notFoundLocaleFromPath(location.pathname);
const seo = SEO[locale];
const messages = TRANS[locale];
document.documentElement.lang = seo.lang;
document.documentElement.dir = seo.dir;
document.title = messages.not_found_title_tag;
document.querySelectorAll('[data-i18n]').forEach((node) => {
  node.textContent = messages[node.dataset.i18n];
});
document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
  node.setAttribute('aria-label', messages[node.dataset.i18nAria]);
});
document.querySelectorAll('[data-not-found-home]').forEach((node) => {
  node.setAttribute('href', seo.path);
});
document.querySelector('[data-not-found-product]').setAttribute('href', `https://shadow.wang/${locale}/products/shadow-snap`);

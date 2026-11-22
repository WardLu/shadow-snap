// 首页按浏览器语言跳转（统一规格：用户 2026-11-02 定，修订后不新增存储）。
// 这是经典脚本（不是 module），由 index.html 的 <head> 靠前位置同步加载，在首屏绘制前执行。
// CSP 为 script-src 'self'，所以必须是同源外部文件，不能内联。
// 只在根地址 `/`（简体，默认语言）判断；其他页面不做任何事。
// 不读写浏览器存储与 Cookie；只在当前历史条目的 history.state 上打标记。
(function () {
  'use strict';

  // `/` 自身的语言；匹配不上任何语言时用英文兜底。
  var ROOT_LOCALE = 'zh';
  var FALLBACK_LOCALE = 'en';
  // 每个语言首页的规范地址，与 canonical 和 hreflang 写法一致。
  var PATHS = {
    zh: '/',
    'zh-hant': '/zh-hant/',
    en: '/en/',
    ja: '/ja/',
    ko: '/ko/',
    es: '/es/',
    pt: '/pt/',
    fr: '/fr/',
    de: '/de/',
    ru: '/ru/',
    id: '/id/',
    ar: '/ar/'
  };
  // 2026-11-02 统一规格：(^|[^u])bot\b 覆盖 AdsBot、PetalBot、Storebot、Slackbot、TelegramBot，并排除 CUBOT（bot 前面是 U）。
  // 不用后行断言（旧版 Safari 不支持，会导致整段脚本失效）。不用裸 bot 与 preview（会命中 CUBOT 手机与 Safari Technology Preview）。
  var BOT = /(^|[^u])bot\b(?!-[a-z]{1,2}\d)|bot\/|crawler|spider|crawling|slurp|facebookexternalhit|embedly|google-inspectiontool|googleother|mediapartners-google|bingpreview/i;

  // 单个语言标签对应的站点语言；不支持时返回 null。
  function matchLocale(tag) {
    if (typeof tag !== 'string') return null;
    var parts = tag.toLowerCase().split('-');
    var primary = parts[0];
    if (!/^[a-z]{2,3}$/.test(primary)) return null;
    if (primary === 'zh') {
      // zh-Hant、zh-TW、zh-HK、zh-MO（含 zh-Hant-*）进繁体；其余 zh（zh、zh-CN、zh-SG、zh-Hans）进简体。
      var sub = parts[1];
      return sub === 'hant' || sub === 'tw' || sub === 'hk' || sub === 'mo' ? 'zh-hant' : 'zh';
    }
    return Object.prototype.hasOwnProperty.call(PATHS, primary) ? primary : null;
  }

  // 按浏览器给出的顺序取第一个能匹配的语言；全部匹配不上时用英文。
  function resolveLocale(languages) {
    for (var i = 0; i < languages.length; i++) {
      var locale = matchLocale(languages[i]);
      if (locale) return locale;
    }
    return FALLBACK_LOCALE;
  }

  function browserLanguages(nav) {
    if (nav && nav.languages && nav.languages.length) return Array.prototype.slice.call(nav.languages);
    return nav && nav.language ? [nav.language] : [];
  }

  // 站内来源：referrer 与当前页同源（例如从语言切换器、404 页的语言链接进入 `/`）时不跳，
  // 说明用户刚刚手动选了这个语言。直接打开、从外站或书签进入时才按浏览器语言匹配。
  function fromSameSite(referrer, origin) {
    if (!referrer) return false;
    try {
      return new URL(referrer).origin === origin;
    } catch (error) {
      return false;
    }
  }

  // history.state 标记：站内选过的语言在刷新后仍生效。标记只写在当前历史条目上，不是存储。
  var CHOSEN_KEY = 'shadowLocaleChosen';

  function isChosen(state) {
    return !!(state && state[CHOSEN_KEY]);
  }

  // 站内来源进入 `/` 时需要打标记：刷新后 referrer 已不再是站内来源，只能靠这个标记保持语言。
  function needsMark(env) {
    return env.pathname === '/' && !BOT.test(env.userAgent || '') && !isChosen(env.state) && fromSameSite(env.referrer, env.origin);
  }

  // 返回应当跳转到的地址；不需要跳转时返回 null。
  function decide(env) {
    if (env.pathname !== '/') return null;
    if (BOT.test(env.userAgent || '')) return null;
    if (isChosen(env.state)) return null;
    if (fromSameSite(env.referrer, env.origin)) return null;
    var wanted = resolveLocale(browserLanguages(env.navigator));
    if (wanted === ROOT_LOCALE) return null;
    return PATHS[wanted] + (env.search || '') + (env.hash || '');
  }

  globalThis.ShadowSnapLocale = {
    PATHS: PATHS,
    matchLocale: matchLocale,
    resolveLocale: resolveLocale,
    decide: decide
  };

  var env = {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    origin: location.origin,
    referrer: document.referrer,
    userAgent: navigator.userAgent,
    navigator: navigator,
    state: history.state
  };
  // 站内来源进入 `/`：只改当前历史条目的 state（不改 URL，不写存储），刷新后仍不跳。
  if (needsMark(env)) {
    var marked = Object.assign({}, history.state);
    marked[CHOSEN_KEY] = true;
    history.replaceState(marked, '');
  }
  var target = decide(env);
  // 用 replace 不写历史记录：回退时不会再经过根地址。
  if (target) location.replace(target);
})();

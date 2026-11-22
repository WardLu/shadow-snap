import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { LOCALES, SEO } from '../../seo-content.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(repoRoot, 'locale-redirect.js'), 'utf8');
const ORIGIN = 'https://snap.shadow.wang';
const BROWSER ='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36';

// Runs the real classic script in a fresh context. It records every location.replace and location.assign call,
// and every storage or cookie access, so the tests can check what the script does and what it must not touch.
function runScript({ pathname = '/', search = '', hash = '', origin = ORIGIN, referrer = '', userAgent = BROWSER, languages, language, state = null } = {}) {
  const replaced = [];
  const replacedStates = [];
  // history.state 的替身：只记录 replaceState 写入的内容，用来断言标记。
  const historyStub = {
    state,
    // 复制一份到当前 realm：沙箱里的对象原型不同，deepStrictEqual 会因此判不等。
    replaceState(next) { replacedStates.push(JSON.parse(JSON.stringify(next))); historyStub.state = next; },
  };
  const assigned = [];
  const touched = [];
  const storage = (name) => ({
    getItem() { touched.push(`${name}.getItem`); return null; },
    setItem() { touched.push(`${name}.setItem`); },
    removeItem() { touched.push(`${name}.removeItem`); },
    clear() { touched.push(`${name}.clear`); },
  });
  const document = {
    referrer,
    get cookie() { touched.push('cookie.get'); return ''; },
    set cookie(value) { touched.push(`cookie.set:${value}`); },
  };
  const sandbox = {
    URL,
    history: historyStub,
    location: { pathname, search, hash, origin, replace: (url) => replaced.push(url), assign: (url) => assigned.push(url) },
    navigator: { userAgent, languages, language },
    document,
    localStorage: storage('localStorage'),
    sessionStorage: storage('sessionStorage'),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { replaced, assigned, touched, replacedStates, api: sandbox.ShadowSnapLocale };
}

test('the redirect script is a classic same-origin file that never touches storage or cookies', () => {
  assert.doesNotMatch(source, /^\s*(import|export)\b/m, 'classic script, not a module');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/, 'no storage or cookie in the source');
  for (const languages of [['ja'], ['zh-TW'], []]) {
    const { touched } = runScript({ languages, referrer: 'https://www.google.com/' });
    assert.deepEqual(touched, [], `no storage or cookie access for ${languages.join(',') || 'empty list'}`);
  }
});

test('every supported locale has the same home path as the SEO table', () => {
  const { PATHS } = runScript().api;
  assert.deepEqual(Object.keys(PATHS).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) assert.equal(PATHS[locale], SEO[locale].path, locale);
});

test('matchLocale maps every tag in the brief and rejects the rest', () => {
  const { matchLocale } = runScript().api;
  const cases = {
    'zh-Hant': 'zh-hant', 'zh-TW': 'zh-hant', 'zh-HK': 'zh-hant', 'zh-MO': 'zh-hant', 'zh-Hant-TW': 'zh-hant',
    'ZH-TW': 'zh-hant', 'ZH-hant-hk': 'zh-hant',
    zh: 'zh', 'zh-CN': 'zh', 'zh-SG': 'zh', 'zh-Hans': 'zh', 'zh-Hans-HK': 'zh', 'ZH-CN': 'zh',
    'JA': 'ja', 'EN-us': 'en',
    'pt-PT': 'pt', 'fr-CA': 'fr', 'es-419': 'es', 'en-US': 'en', ja: 'ja', 'ja-JP': 'ja', 'ar-EG': 'ar',
    hi: null, th: null, 'sr-Latn': null, '': null, '!!': null,
  };
  for (const [tag, expected] of Object.entries(cases)) assert.equal(matchLocale(tag), expected, tag);
});

test('resolveLocale keeps browser order and falls back to English when nothing matches', () => {
  const { resolveLocale } = runScript().api;
  assert.equal(resolveLocale(['hi', 'ja-JP', 'zh-TW']), 'ja');
  assert.equal(resolveLocale(['zh-TW', 'ja-JP']), 'zh-hant');
  assert.equal(resolveLocale(['xx-YY', 'pt-PT']), 'pt');
  assert.equal(resolveLocale(['hi', 'th']), 'en');
  assert.equal(resolveLocale([]), 'en');
});

test('a direct visit to the root moves to the matched locale home and stays for the root language', () => {
  const cases = [
    [['ja-JP'], '/ja/'],
    [['zh-TW'], '/zh-hant/'],
    [['zh-HK'], '/zh-hant/'],
    [['zh-CN'], null],
    [['fr-CA'], '/fr/'],
    [['hi'], '/en/'],
    [['th-TH', 'en-GB'], '/en/'],
    [['th-TH', 'ja-JP'], '/ja/'],
  ];
  for (const [languages, target] of cases) {
    const { replaced, assigned } = runScript({ languages });
    assert.deepEqual(replaced, target ? [target] : [], languages.join(','));
    assert.deepEqual(assigned, [], 'location.replace only, never assign');
  }
});

test('navigator.language is used when navigator.languages is empty', () => {
  assert.deepEqual(runScript({ languages: [], language: 'ja-JP' }).replaced, ['/ja/']);
  assert.deepEqual(runScript({ languages: [] }).replaced, ['/en/']);
});

test('only the bare root is checked, and query and hash survive the redirect', () => {
  assert.deepEqual(runScript({ pathname: '/en/', languages: ['ja'] }).replaced, []);
  assert.deepEqual(runScript({ pathname: '/ja/', languages: ['en'] }).replaced, []);
  assert.deepEqual(runScript({ pathname: '/', languages: ['ja'], search: '?utm=1', hash: '#faq' }).replaced, ['/ja/?utm=1#faq']);
});

// 规格第 5 条（2026-11-02 收窄）：这些 UA 必须判为爬虫，不跳转。
const CRAWLER_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  // 规格第 5 条（2026-11-02 扩充）：(^|[^u])bot\b 新覆盖的爬虫。
  'Mozilla/5.0 (compatible; AdsBot-Google; +http://www.google.com/adsbot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
  'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
  'Storebot-Google/1.0',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'TelegramBot (like TwitterBot)',
  // 2026-11-02 扩充后的正例：带版本号的 Google 图片爬虫（不含 bot 的 URL）。
  'Mozilla/5.0 (compatible; Googlebot-Image/1.0)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0)',
  // 正则里其余分支各取一个真实 UA，避免分支被误删后测试仍然通过。
  'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
  'Mozilla/5.0 (compatible; embedly/1.0; +http://support.embedly.com)',
  'Mediapartners-Google',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; GoogleOther)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.62 BingPreview/1.0b',
];
// 收窄后不能再误判为爬虫：CUBOT 手机名里含 “bot”，Safari Technology Preview 里含 “preview”。
const HUMAN_AGENTS = [
  'Mozilla/5.0 (Linux; Android 9; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 9; CUBOT P30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Technology Preview/190',
  // 华为平板的型号以 BOT 开头（BOT-AL00、BOT-LX1、BOT-W09），不应判为爬虫。
  'Mozilla/5.0 (Linux; Android 10; BOT-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; BOT-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; BOT-W09) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Safari/537.36',
];

test('crawler user agents keep the root page whatever their language list says', () => {
  for (const userAgent of CRAWLER_AGENTS) {
    assert.deepEqual(runScript({ userAgent, languages: ['en-US'] }).replaced, [], userAgent);
    assert.deepEqual(runScript({ userAgent, languages: ['ja'] }).replaced, [], userAgent);
  }
  assert.deepEqual(runScript({ userAgent: 'Mozilla/5.0 (compatible; SomeCrawler/1.0)', languages: ['ja'] }).replaced, []);
});

test('human user agents whose names merely contain bot or preview are not treated as crawlers', () => {
  for (const userAgent of HUMAN_AGENTS) {
    const { replaced } = runScript({ userAgent, languages: ['ja'] });
    assert.deepEqual(replaced, ['/ja/'], userAgent);
  }
});

test('a same-site referrer means the user chose a language in the site, so the root page stays put', () => {
  assert.deepEqual(runScript({ referrer: `${ORIGIN}/en/`, languages: ['ja'] }).replaced, []);
  assert.deepEqual(runScript({ referrer: `${ORIGIN}/`, languages: ['zh-TW'] }).replaced, []);
  assert.deepEqual(runScript({ referrer: `${ORIGIN}/ja/?x=1`, languages: ['zh-TW'] }).replaced, []);
});

test('a same-site visit to the root marks its history entry, and the mark keeps the chosen language on refresh', () => {
  const visit = runScript({ referrer: `${ORIGIN}/ja/`, languages: ['ja'] });
  assert.deepEqual(visit.replaced, [], 'a same-site visit is not redirected');
  assert.deepEqual(visit.replacedStates, [{ shadowLocaleChosen: true }]);
  assert.deepEqual(visit.touched, [], 'the mark is history state, not storage');
  const keeps = runScript({ referrer: `${ORIGIN}/ja/`, languages: ['ja'], state: { keep: 1 } });
  assert.deepEqual(keeps.replacedStates, [{ keep: 1, shadowLocaleChosen: true }], 'existing history state is kept');
  // 刷新：referrer 已不再是站内来源，但历史条目带着标记，浏览器语言不同也不跳。
  const refresh = runScript({ referrer: '', languages: ['ja'], state: { shadowLocaleChosen: true } });
  assert.deepEqual(refresh.replaced, [], 'a marked entry stays on the root after a refresh');
  assert.deepEqual(refresh.replacedStates, [], 'a marked entry is not marked again');
});

test('only a same-site visit to the bare root is marked; direct visits, external referrers, crawlers and other paths are not', () => {
  assert.deepEqual(runScript({ pathname: '/ja/', referrer: `${ORIGIN}/`, languages: ['ja'] }).replacedStates, []);
  assert.deepEqual(runScript({ referrer: '', languages: ['ja'] }).replacedStates, []);
  assert.deepEqual(runScript({ referrer: 'https://www.google.com/', languages: ['ja'] }).replacedStates, []);
  assert.deepEqual(runScript({ userAgent: CRAWLER_AGENTS[0], referrer: `${ORIGIN}/`, languages: ['ja'] }).replacedStates, []);
});

test('the language switcher pushes the same mark when it moves to the root', async () => {
  const scriptJs = await readFile(path.join(repoRoot, 'script.js'), 'utf8');
  assert.match(scriptJs, /const state = SEO\[lang\]\.path === '\/' \? \{ shadowLocaleChosen: true \} : null;/);
  assert.match(scriptJs, /history\.pushState\(state, '', SEO\[lang\]\.path/);
});

test('an external, foreign-scheme, look-alike or missing referrer is treated as a direct visit', () => {
  assert.deepEqual(runScript({ referrer: 'https://www.google.com/', languages: ['ja'] }).replaced, ['/ja/']);
  assert.deepEqual(runScript({ referrer: '', languages: ['ja'] }).replaced, ['/ja/']);
  assert.deepEqual(runScript({ referrer: 'https://snap.shadow.wang.example.com/', languages: ['ja'] }).replaced, ['/ja/']);
  assert.deepEqual(runScript({ referrer: 'http://snap.shadow.wang/en/', languages: ['ja'] }).replaced, ['/ja/']);
  assert.deepEqual(runScript({ referrer: 'not a url', languages: ['ja'] }).replaced, ['/ja/']);
});

test('every localized page loads the redirect script in head before the stylesheet', async () => {
  for (const locale of LOCALES) {
    const html = await readFile(path.join(repoRoot, `${SEO[locale].path.slice(1)}index.html`), 'utf8');
    const script = html.indexOf('<script src="/locale-redirect.js"></script>');
    assert.ok(script > 0, `${locale} loads locale-redirect.js`);
    assert.ok(script < html.indexOf('<link rel="stylesheet" href="/style.css">'), `${locale} script before stylesheet`);
    assert.ok(script < html.indexOf('</head>'), `${locale} script inside head`);
  }
});

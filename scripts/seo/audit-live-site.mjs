import https from 'node:https';

const BASE_URL = process.env.SITE_URL || 'https://snap.shadow.wang';
const routes = ['/'];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, html: data }));
      })
      .on('error', reject);
  });
}

async function verifyLive() {
  console.log(`🔍 正在对 ${BASE_URL} 线上环境进行 AITDK 回读校验...`);
  let hasErrors = false;

  for (const route of routes) {
    const fullUrl = `${BASE_URL}${route}`;
    try {
      const { status, html } = await fetchUrl(fullUrl);
      if (status !== 200) {
        console.error(`❌ ${fullUrl} 返回异常 HTTP ${status}`);
        hasErrors = true;
        continue;
      }

      const titleMatch = html.match(/<title\b[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : '';
      const titleLen = title.length;

      const descMatch =
        html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) ||
        html.match(/<meta\s+content="([^"]*)"\s+name="description"/i);
      const desc = descMatch ? descMatch[1] : '';
      const descLen = desc.length;

      const hasAmp = title.includes('&amp;') || title.includes('&') || desc.includes('&amp;') || desc.includes('&');

      let statusIcon = '✅';
      const issues = [];
      if (titleLen < 30 || titleLen > 60) issues.push(`Title (${titleLen})`);
      if (descLen < 140 || descLen > 160) issues.push(`Desc (${descLen})`);
      if (hasAmp) issues.push('& entity');

      if (issues.length > 0) {
        statusIcon = '⚠️';
        hasErrors = true;
        console.warn(`${statusIcon} [FAIL] ${route}: Title ${titleLen} 字符, Desc ${descLen} 字符 | 问题: ${issues.join(', ')}`);
      } else {
        console.log(`${statusIcon} [PASS] ${route}: HTTP 200 | Title: ${titleLen} 字符 ("${title}") | Desc: ${descLen} 字符`);
      }
    } catch (err) {
      console.error(`❌ 获取 ${fullUrl} 失败:`, err.message);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('❌ 线上路由未完全满足 AITDK 零缺陷标准');
    process.exit(1);
  } else {
    console.log('🎉 线上 AITDK 回读验收全部 100% 通过！');
  }
}

verifyLive().catch((err) => {
  console.error(err);
  process.exit(1);
});

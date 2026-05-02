// api/proxy.js - Vercel Function for GitHub Proxy

// 域名映射配置
const domain_mappings = {
  'github.com': 'v-gh.',
  'avatars.githubusercontent.com': 'v-avatars-githubusercontent-com.',
  'github.githubassets.com': 'v-github-githubassets-com.',
  'collector.github.com': 'v-collector-github-com.',
  'api.github.com': 'v-api-github-com.',
  'raw.githubusercontent.com': 'v-raw-githubusercontent-com.',
  'gist.githubusercontent.com': 'v-gist-githubusercontent-com.',
  'github.io': 'v-github-io.',
  'assets-cdn.github.com': 'v-assets-cdn-github-com.',
  'cdn.jsdelivr.net': 'v-cdn.jsdelivr-net.',
  'securitylab.github.com': 'v-securitylab-github-com.',
  'www.githubstatus.com': 'v-www-githubstatus-com.',
  'npmjs.com': 'v-npmjs-com.',
  'git-lfs.github.com': 'v-git-lfs-github-com.',
  'githubusercontent.com': 'v-githubusercontent-com.',
  'github.global.ssl.fastly.net': 'v-github-global-ssl-fastly-net.',
  'api.npms.io': 'v-api-npms-io.',
  'github.community': 'v-github-community.'
};

// 需要重定向的路径
const redirect_paths = ['/'];

// 获取当前主机名的前缀，用于匹配反向映射
function getProxyPrefix(host) {
  if (host.startsWith('gh.')) {
    return 'gh.';
  }
  for (const prefix of Object.values(domain_mappings)) {
    if (host.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

// 修改响应内容
async function modifyResponse(response, host_prefix, effective_hostname) {
  const content_type = response.headers.get('content-type') || '';
  if (!content_type.includes('text/') &&
      !content_type.includes('application/json') &&
      !content_type.includes('application/javascript') &&
      !content_type.includes('application/xml')) {
    return response.body;
  }

  let text = await response.text();
  const domain_suffix = effective_hostname.substring(host_prefix.length);

  // 替换所有域名引用
  for (const [original_domain, proxy_prefix] of Object.entries(domain_mappings)) {
    const escaped_domain = original_domain.replace(/\./g, '\\.');
    const full_proxy_domain = `${proxy_prefix}${domain_suffix}`;
    
    text = text.replace(
      new RegExp(`https?://${escaped_domain}(?=/|"|'|\\s|$)`, 'g'),
      `https://${full_proxy_domain}`
    );
    text = text.replace(
      new RegExp(`//${escaped_domain}(?=/|"|'|\\s|$)`, 'g'),
      `//${full_proxy_domain}`
    );
  }

  // 处理相对路径（仅限于 gh. 前缀的通用 GitHub 代理）
  if (host_prefix === 'gh.') {
    text = text.replace(
      /(?<=["'])\/(?!\/|[a-zA-Z]+:)/g,
      `https://${effective_hostname}/`
    );
  }

  return text;
}

// Vercel Function 主处理函数
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const current_host = req.headers.host || url.host;
    const effective_host = req.headers.host || current_host;

    // 处理 OPTIONS 请求（CORS 预检）
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(200).end();
    }

    // 从有效主机名中提取前缀
    const host_prefix = getProxyPrefix(effective_host);
    if (!host_prefix) {
      return res.status(404).send('Domain not configured for proxy');
    }

    // 根据前缀找到对应的原始域名
    let target_host = null;
    for (const [original, prefix] of Object.entries(domain_mappings)) {
      if (prefix === host_prefix) {
        target_host = original;
        break;
      }
    }

    if (!target_host) {
      return res.status(404).send('Domain not configured for proxy');
    }

    // 处理路径，修复可能的嵌套 URL
    let pathname = url.pathname;
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https%3A\/\/[^\/]+\/.*/, '$1');
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https:\/\/[^\/]+\/.*/, '$1');

    // 构建新的请求URL
    const new_url = new URL(`https://${target_host}${pathname}${url.search}`);

    // 设置新的请求头
    const new_headers = new Headers();
    const headers_to_skip = ['host', 'connection', 'cf-', 'x-forwarded-', 'x-vercel-'];
    for (const [key, value] of Object.entries(req.headers)) {
      const lower_key = key.toLowerCase();
      if (!headers_to_skip.some(skip => lower_key.startsWith(skip))) {
        new_headers.set(key, value);
      }
    }
    new_headers.set('Host', target_host);
    new_headers.set('Referer', new_url.href);

    // 准备请求选项
    const fetchOptions = {
      method: req.method,
      headers: new_headers,
      redirect: 'manual'
    };

    // 处理请求体
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      if (bodyChunks.length > 0) {
        fetchOptions.body = Buffer.concat(bodyChunks);
      }
    }

    // 发起请求
    const response = await fetch(new_url.href, fetchOptions);

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        let new_location = location;
        for (const [original_domain, proxy_prefix] of Object.entries(domain_mappings)) {
          if (location.includes(original_domain)) {
            const domain_suffix = effective_host.substring(host_prefix.length);
            const full_proxy_domain = `${proxy_prefix}${domain_suffix}`;
            new_location = location.replace(original_domain, full_proxy_domain);
            break;
          }
        }
        res.setHeader('Location', new_location);
        return res.status(response.status).end();
      }
    }

    // ===== 核心修改：处理响应头，尤其是 Set-Cookie =====
    // 先设置几个通用的响应头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Cache-Control', 'public, max-age=14400');

    const response_headers_to_skip = [
      'content-encoding',
      'content-length',
      'content-security-policy',
      'content-security-policy-report-only',
      'clear-site-data',
      'connection',
      'transfer-encoding'
    ];

    const setCookieHeaders = [];

    response.headers.forEach((value, key) => {
      const lower_key = key.toLowerCase();

      // 跳过不需要的响应头
      if (response_headers_to_skip.includes(lower_key)) {
        return;
      }

      // 单独处理 Set-Cookie
      if (lower_key === 'set-cookie') {
        let cookie = value;
        // 替换 domain 为当前的代理域名
        cookie = cookie.replace(
          /domain=\.?github\.com(;|$)/gi,
          `domain=${effective_host}$1`
        );
        // 如果代理环境不是 HTTPS，需要去掉 Secure 标记，否则浏览器会拒绝
        // 下面这行可以根据实际情况启用（取消注释即可）
        // cookie = cookie.replace(/;\s*secure\b/gi, '');
        setCookieHeaders.push(cookie);
      } else {
        // 其他响应头直接设置
        res.setHeader(key, value);
      }
    });

    // 设置所有修改后的 Set-Cookie 头（Node.js 支持数组形式的 Set-Cookie）
    if (setCookieHeaders.length > 0) {
      res.setHeader('Set-Cookie', setCookieHeaders);
    }

    // 设置状态码
    res.status(response.status);

    // 处理响应内容
    const content_type = response.headers.get('content-type') || '';
    if (content_type.includes('text/') ||
        content_type.includes('application/json') ||
        content_type.includes('application/javascript') ||
        content_type.includes('application/xml')) {
      const modified_body = await modifyResponse(response.clone(), host_prefix, effective_host);
      res.send(modified_body);
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(502).json({
      error: 'Proxy Error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// 配置 Vercel Function
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 30,
};

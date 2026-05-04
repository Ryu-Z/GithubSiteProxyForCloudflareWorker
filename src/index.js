// 域名白名单配置（仅保留需要的原生域名）
const domain_whitelist = [
  'github.com',
  'avatars.githubusercontent.com',
  'github.githubassets.com',
  'collector.github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'github.io',
  'assets-cdn.github.com',
  'cdn.jsdelivr.net',
  'securitylab.github.com',
  'www.githubstatus.com',
  'npmjs.com',
  'git-lfs.github.com',
  'githubusercontent.com',
  'github.global.ssl.fastly.net',
  'api.npms.io',
  'github.community',
  'desktop.github.com',
  'central.github.com',
  'release-assets.githubusercontent.com'
];

const github_host = 'github.com';
const github_short_prefix = 'gh.';

// 需要重定向的路径（屏蔽海外后可以不填写）
const redirect_paths = [];

// 中国大陆以外的地区重定向到原始 GitHub 域名
const enable_geo_redirect = true;

// 缓存默认只覆盖匿名静态资源，避免把登录态、私有仓库或动态页面缓存到边缘节点。
const enable_cache = true;
const cache_ttl_seconds = 14400;
const cacheable_hosts = new Set([
  'avatars.githubusercontent.com',
  'github.githubassets.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'githubusercontent.com',
  'release-assets.githubusercontent.com',
  'assets-cdn.github.com',
  'cdn.jsdelivr.net'
]);

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, ctx);
  }
};

async function handleRequest(request, ctx) {
  const url = new URL(request.url);
  const current_host = url.host.toLowerCase();
  const host_header = request.headers.get('Host');
  const effective_host = (host_header || current_host).toLowerCase();

  if (enable_geo_redirect) {
    const country = request.headers.get('CF-IPCountry') || '';
    if (country && country !== 'CN') {
      const route = resolveRoute(effective_host);
      if (route) {
        const original_url = new URL(request.url);
        original_url.host = route.target_host;
        original_url.protocol = 'https:';
        return Response.redirect(original_url.href, 302);
      }
    }
  }

  if (redirect_paths.includes(url.pathname)) {
    return new Response('Not Found', { status: 404 });
  }

  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.href);
  }

  const route = resolveRoute(effective_host);
  if (!route) {
    return new Response(`Domain not configured for proxy. Host: ${effective_host}, Prefix check failed`, { status: 404 });
  }

  const target_url = buildTargetUrl(url, route);
  const cache_context = getCacheContext(request, target_url, route.target_host);

  if (cache_context.enabled) {
    const cached_response = await caches.default.match(cache_context.key);
    if (cached_response) {
      const cached_headers = new Headers(cached_response.headers);
      cached_headers.set('x-proxy-cache', 'HIT');
      return new Response(cached_response.body, {
        status: cached_response.status,
        headers: cached_headers
      });
    }
  }

  const upstream_request = await buildUpstreamRequest(request, target_url, route, effective_host);

  try {
    const response = await fetch(upstream_request);
    const proxy_response = await buildProxyResponse(response, route, effective_host, cache_context);

    if (cache_context.enabled && isCacheableProxyResponse(proxy_response)) {
      ctx.waitUntil(caches.default.put(cache_context.key, proxy_response.clone()));
    }

    return proxy_response;
  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, { status: 502 });
  }
}

function resolveRoute(host) {
  const host_prefix = getProxyPrefix(host);
  if (!host_prefix) {
    return null;
  }

  const target_host = getTargetHost(host_prefix);
  if (!target_host) {
    return null;
  }

  return {
    host_prefix,
    target_host,
    use_short_github_prefix: host_prefix === github_short_prefix
  };
}

function getProxyPrefix(host) {
  if (host.startsWith(github_short_prefix)) {
    return github_short_prefix;
  }

  const gh_match = host.match(/^([a-z0-9-]+-gh\.)/);
  if (gh_match) {
    return gh_match[1];
  }

  return null;
}

function getTargetHost(host_prefix) {
  if (host_prefix === github_short_prefix) {
    return github_host;
  }

  if (!host_prefix.endsWith('-gh.')) {
    return null;
  }

  const prefix_part = host_prefix.slice(0, -4);
  for (const original of domain_whitelist) {
    if (original.replace(/\./g, '-') === prefix_part) {
      return original;
    }
  }

  return null;
}

function buildTargetUrl(url, route) {
  const target_url = new URL(url);
  target_url.host = route.target_host;
  target_url.protocol = 'https:';

  let pathname = target_url.pathname;
  pathname = pathname.replace(/(\/[^/]+\/[^/]+\/(?:latest-commit|tree-commit-info)\/[^/]+)\/https%3A\/\/[^/]+\/.*/, '$1');
  pathname = pathname.replace(/(\/[^/]+\/[^/]+\/(?:latest-commit|tree-commit-info)\/[^/]+)\/https:\/\/[^/]+\/.*/, '$1');
  target_url.pathname = pathname;

  for (const [key, value] of target_url.searchParams.entries()) {
    target_url.searchParams.set(key, restoreOriginalUrlsInText(value, route, url.host.toLowerCase()));
  }

  return target_url;
}

async function buildUpstreamRequest(request, target_url, route, effective_host) {
  const headers = new Headers(request.headers);
  sanitizeRequestHeaders(headers);
  headers.set('Host', route.target_host);
  headers.delete('accept-encoding');

  const referer = request.headers.get('Referer');
  if (referer) {
    headers.set('Referer', restoreOriginalUrl(referer, route, effective_host));
  } else {
    headers.set('Referer', target_url.href);
  }

  const origin = request.headers.get('Origin');
  if (origin) {
    headers.set('Origin', restoreOriginalOrigin(origin, route));
  }

  const body = await buildUpstreamBody(request, headers, route, effective_host);

  return new Request(target_url.href, {
    method: request.method,
    headers,
    body,
    redirect: 'manual'
  });
}

async function buildUpstreamBody(request, headers, route, effective_host) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const content_type = request.headers.get('content-type') || '';
  if (content_type.includes('application/x-www-form-urlencoded')) {
    const original_params = new URLSearchParams(await request.text());
    const params = new URLSearchParams();
    for (const [key, value] of original_params.entries()) {
      params.append(key, restoreOriginalUrlsInText(value, route, effective_host));
    }

    const body = params.toString();
    headers.delete('content-length');
    return body;
  }

  if (content_type.includes('application/json') || content_type.includes('text/')) {
    const body = restoreOriginalUrlsInText(await request.text(), route, effective_host);
    headers.delete('content-length');
    return body;
  }

  headers.delete('content-length');
  return request.body;
}

function sanitizeRequestHeaders(headers) {
  const remove_prefixes = ['cf-', 'x-forwarded-'];
  const remove_names = new Set([
    'cdn-loop',
    'connection',
    'content-length',
    'forwarded',
    'true-client-ip',
    'x-real-ip'
  ]);

  for (const name of Array.from(headers.keys())) {
    const lower_name = name.toLowerCase();
    if (remove_names.has(lower_name) || remove_prefixes.some(prefix => lower_name.startsWith(prefix))) {
      headers.delete(name);
    }
  }
}

async function buildProxyResponse(response, route, effective_host, cache_context) {
  const headers = buildResponseHeaders(response.headers, route, effective_host, cache_context);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location) {
      headers.set('location', modifyUrl(location, route, effective_host));
    }

    headers.set('x-proxy-cache', 'BYPASS');
    return new Response(null, {
      status: response.status,
      headers
    });
  }

  const content_type = response.headers.get('content-type') || '';
  const is_text = content_type.includes('text/') ||
                  content_type.includes('application/json') ||
                  content_type.includes('application/javascript') ||
                  content_type.includes('application/xml');

  if (response.status === 200 && is_text) {
    headers.delete('content-encoding');
    headers.delete('content-length');

    let text = await response.text();
    text = await modifyText(text, route, effective_host);

    headers.set('x-proxy-cache', cache_context.enabled ? 'MISS' : 'BYPASS');
    return new Response(text, {
      status: response.status,
      headers
    });
  }

  headers.set('x-proxy-cache', cache_context.enabled ? 'MISS' : 'BYPASS');
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function buildResponseHeaders(source_headers, route, effective_host, cache_context) {
  const headers = new Headers(source_headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-credentials', 'true');
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.delete('clear-site-data');

  headers.delete('set-cookie');
  for (const cookie of getSetCookieHeaders(source_headers)) {
    headers.append('set-cookie', rewriteSetCookie(cookie, route, effective_host));
  }

  if (cache_context.enabled) {
    headers.set('cache-control', `public, max-age=${cache_ttl_seconds}`);
  } else if (isLoginOrSessionPath(new URL(cache_context.target_url).pathname) || hasSetCookie(source_headers)) {
    headers.set('cache-control', 'private, no-store');
  }

  return headers;
}

function getCacheContext(request, target_url, target_host) {
  const method = request.method.toUpperCase();
  const has_auth = request.headers.has('Cookie') || request.headers.has('Authorization');
  const safe_method = method === 'GET';
  const cacheable_path = !isLoginOrSessionPath(target_url.pathname);
  const enabled = enable_cache && safe_method && !has_auth && cacheable_hosts.has(target_host) && cacheable_path;

  return {
    enabled,
    target_url: target_url.href,
    key: new Request(target_url.href, { method: 'GET' })
  };
}

function isCacheableProxyResponse(response) {
  const cache_control = response.headers.get('cache-control') || '';
  return response.status === 200 &&
         !response.headers.has('set-cookie') &&
         !/private|no-store/i.test(cache_control);
}

function isLoginOrSessionPath(pathname) {
  return [
    '/login',
    '/session',
    '/signup',
    '/logout',
    '/password_reset',
    '/sessions/two-factor',
    '/account_verifications'
  ].some(path => pathname === path || pathname.startsWith(`${path}/`));
}

function hasSetCookie(headers) {
  return getSetCookieHeaders(headers).length > 0;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  if (typeof headers.getAll === 'function') {
    return headers.getAll('set-cookie');
  }

  const value = headers.get('set-cookie');
  return value ? splitSetCookieHeader(value) : [];
}

function splitSetCookieHeader(header) {
  const cookies = [];
  let start = 0;
  let in_expires = false;

  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    const chunk = header.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (chunk.endsWith('expires=')) {
      in_expires = true;
    }
    if (in_expires && char === ';') {
      in_expires = false;
    }
    if (!in_expires && char === ',') {
      cookies.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }

  cookies.push(header.slice(start).trim());
  return cookies.filter(Boolean);
}

function rewriteSetCookie(cookie, route, effective_host) {
  const domain_suffix = getDomainSuffix(route.host_prefix, effective_host);
  const proxy_host = getProxyHost(route.target_host, domain_suffix, route.use_short_github_prefix);
  const parts = cookie.split(';').map(part => part.trim());
  const rewritten = [];
  let has_path = false;

  for (const part of parts) {
    if (/^domain=/i.test(part)) {
      rewritten.push(`Domain=${proxy_host}`);
      continue;
    }

    if (/^path=/i.test(part)) {
      has_path = true;
    }

    rewritten.push(part);
  }

  if (!has_path) {
    rewritten.push('Path=/');
  }

  return rewritten.join('; ');
}

function restoreOriginalUrl(url_str, route, effective_host) {
  try {
    const url = new URL(url_str);
    const proxy_prefix = getProxyPrefix(url.host.toLowerCase());
    if (!proxy_prefix) {
      return url_str;
    }

    const target_host = getTargetHost(proxy_prefix);
    if (target_host) {
      url.host = target_host;
      url.protocol = 'https:';
    }

    for (const [key, value] of url.searchParams.entries()) {
      url.searchParams.set(key, restoreOriginalUrlsInText(value, route, effective_host));
    }

    return url.href;
  } catch (e) {
    return url_str.replace(route.host_prefix, '');
  }
}

function restoreOriginalOrigin(origin_str, route) {
  try {
    const url = new URL(origin_str);
    const proxy_prefix = getProxyPrefix(url.host.toLowerCase());
    if (!proxy_prefix) {
      return origin_str;
    }

    const target_host = getTargetHost(proxy_prefix);
    if (target_host) {
      return `https://${target_host}`;
    }

    return origin_str;
  } catch (e) {
    return route.target_host ? `https://${route.target_host}` : origin_str;
  }
}

function restoreOriginalUrlsInText(text, route, effective_hostname) {
  const domain_suffix = getDomainSuffix(route.host_prefix, effective_hostname);

  for (const original_domain of domain_whitelist) {
    const proxy_hosts = getProxyHosts(original_domain, domain_suffix);

    for (const proxy_host of proxy_hosts) {
      const escaped_proxy = proxy_host.replace(/\./g, '\\.');
      text = text.replace(
        new RegExp(`https?://${escaped_proxy}(?=/|"|'|\\s|$)`, 'g'),
        `https://${original_domain}`
      );
      text = text.replace(
        new RegExp(`//${escaped_proxy}(?=/|"|'|\\s|$)`, 'g'),
        `//${original_domain}`
      );
    }
  }

  return text;
}

async function modifyText(text, route, effective_hostname) {
  const domain_suffix = getDomainSuffix(route.host_prefix, effective_hostname);

  for (const original_domain of domain_whitelist) {
    const escaped_domain = original_domain.replace(/\./g, '\\.');
    const full_proxy_domain = getProxyHost(original_domain, domain_suffix, route.use_short_github_prefix);

    text = text.replace(
      new RegExp(`https?://${escaped_domain}(?=/|"|'|\\s|$)`, 'g'),
      `https://${full_proxy_domain}`
    );

    text = text.replace(
      new RegExp(`//${escaped_domain}(?=/|"|'|\\s|$)`, 'g'),
      `//${full_proxy_domain}`
    );
  }

  return text;
}

function modifyUrl(url_str, route, effective_hostname) {
  try {
    const url = new URL(url_str);
    const domain_suffix = getDomainSuffix(route.host_prefix, effective_hostname);

    for (const original_domain of domain_whitelist) {
      if (url.host === original_domain) {
        url.host = getProxyHost(original_domain, domain_suffix, route.use_short_github_prefix);
        break;
      }
    }
    return url.href;
  } catch (e) {
    return url_str;
  }
}

function getProxyHost(original_domain, domain_suffix, use_short_github_prefix) {
  if (original_domain === github_host && use_short_github_prefix) {
    return `${github_short_prefix}${domain_suffix}`;
  }

  return `${original_domain.replace(/\./g, '-')}-gh.${domain_suffix}`;
}

function getProxyHosts(original_domain, domain_suffix) {
  const hosts = [`${original_domain.replace(/\./g, '-')}-gh.${domain_suffix}`];
  if (original_domain === github_host) {
    hosts.push(`${github_short_prefix}${domain_suffix}`);
  }

  return hosts;
}

function getDomainSuffix(host_prefix, effective_hostname) {
  return effective_hostname.substring(host_prefix.length);
}

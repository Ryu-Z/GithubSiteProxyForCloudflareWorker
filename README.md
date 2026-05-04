# GitHub代理服务

## 项目概述

这是一个基于Cloudflare Workers的GitHub代理服务，允许通过替代域名访问GitHub资源，解决某些网络环境下GitHub访问受限的问题。代理服务通过域名映射和资源转发，提供无缝的GitHub浏览体验。

## 特性

- **子域名匹配系统**：使用 `gh.` 前缀作为GitHub主站的代理入口，支持任何域名后缀
- **完整的资源映射**：支持GitHub相关的所有主要域名，包括API、静态资源、用户内容等
- **内容替换**：自动替换响应中的所有域名引用，确保链接正常工作
- **路径修复**：解决嵌套URL路径问题，特别针对仓库提交信息等特殊路径
- **登录代理**：支持 GitHub 登录相关的 `Cookie`、`Set-Cookie`、`Location`、`Origin` 和 `Referer` 改写
- **边缘缓存**：使用 Cloudflare Worker Cache API 缓存匿名静态资源，登录态请求默认绕过缓存
- **安全重定向**：可通过 `redirect_paths` 对指定敏感路径返回 404
- **HTTPS强制**：自动将HTTP请求升级为HTTPS

## 支持的域名映射

服务支持以下GitHub相关域名的代理访问：

- github.com → gh.[您的域名] 或 github-com-gh.[您的域名]
- avatars.githubusercontent.com → avatars-githubusercontent-com-gh.[您的域名]
- github.githubassets.com → github-githubassets-com-gh.[您的域名]
- api.github.com → api-github-com-gh.[您的域名]
- raw.githubusercontent.com → raw-githubusercontent-com-gh.[您的域名]
- 以及更多GitHub相关服务域名

## 部署指南

### 前提条件

- Cloudflare账户
- 已配置的域名（托管在Cloudflare上）
- 基本的DNS配置知识

### 部署步骤

1. **登录Cloudflare控制台**
   - 进入Workers部分

2. **创建新的Worker**
   - 点击"创建Worker"
   - 将提供的代码粘贴到代码编辑器中
   - 给Worker命名并保存

3. **配置对应其他资源的域名映射**
   - 更改域名映射配置，将所有相关域名指向您的Worker路由
   - 将 `github.com` 指向您的Worker路由域名 `gh.您的域名`
   - 将 `avatars.githubusercontent.com` 等其他资源指向您的Worker路由域名 `avatars-githubusercontent-com-gh.您的域名`

4. **配置DNS记录**
   - 为您的泛域名添加任何命中CDN的记录
   - 例如 `*.您的域名` A记录指向任何IP并开启代理

5. **配置Worker路由**
   - 添加路由 `*-gh.您的域名/*` 和 `gh.您的域名/*` 指向您的Worker

### 配置自定义域名

如果您想使用不同的域名前缀（仅github.com主站），请修改代码中的`domain_mappings`对象，将默认的`gh.`等前缀替换为您喜欢的前缀。

## 使用方法

部署成功后，只需将原始GitHub URL中的域名部分替换为对应的代理域名：

```
# 原始URL
https://github.com/用户名/仓库名

# 代理URL
https://gh.您的域名/用户名/仓库名
```

其他GitHub资源的访问方式类似，系统会自动处理域名映射和内容替换。

## 登录与缓存说明

### 登录代理

登录能力依赖以下改写逻辑：

- 将 GitHub 返回的 `Set-Cookie` 的 `Domain` 改写为当前代理域名
- 将 GitHub 的 `Location` 重定向地址改写回代理域名
- 将浏览器请求中的 `Origin` 和 `Referer` 还原为原始 GitHub 域名后再回源
- 删除 GitHub 的 CSP 和 `clear-site-data` 响应头，避免代理域名下页面被源站策略拦截

### 缓存策略

默认只缓存匿名 `GET` 请求，并且仅缓存以下静态或公开资源域名：

- `avatars.githubusercontent.com`
- `github.githubassets.com`
- `raw.githubusercontent.com`
- `gist.githubusercontent.com`
- `githubusercontent.com`
- `release-assets.githubusercontent.com`
- `assets-cdn.github.com`
- `cdn.jsdelivr.net`

以下请求不会进入边缘缓存：

- 带 `Cookie` 或 `Authorization` 的请求
- 登录、登出、会话、注册、密码重置、二次验证相关路径
- 非 `GET` 请求
- 非缓存域名的动态页面请求

### 验证命令

部署后可使用以下命令验证：

```bash
# 验证代理入口是否可访问
curl -I https://gh.您的域名/

# 验证登录页是否返回 Set-Cookie，且 Domain 已改写为代理域名
curl -I https://gh.您的域名/login

# 验证静态资源缓存，第二次请求应看到 x-proxy-cache: HIT
curl -I https://github-githubassets-com-gh.您的域名/assets/primer.css
curl -I https://github-githubassets-com-gh.您的域名/assets/primer.css
```

### 风险点

- GitHub 登录流程可能随官方前端和安全策略调整而变化，生产使用前需要完整验证登录、二次验证、登出和私有仓库访问。
- Worker Cache 是边缘缓存，错误缓存登录态响应会造成数据泄露风险，因此当前实现默认只缓存匿名静态资源。
- 如果前面还有企业代理、WAF 或出口代理，请同时检查 `NO_PROXY` 是否需要包含内网地址、Kubernetes Service 网段和常见本地域名，避免内部访问被错误转发。

### 回滚方案

```bash
# 回滚到主分支当前线上版本
git checkout main
wrangler deploy

# 或者回滚单个 Worker 版本
wrangler deployments list
wrangler rollback
```

## 技术说明

### 工作原理

1. 接收对代理域名的请求
2. 识别目标GitHub域名
3. 转发请求到GitHub服务器
4. 接收GitHub的响应
5. 替换响应内容中的域名引用
6. 返回修改后的响应给用户

### 特殊路径处理

代码包含专门的逻辑来处理特殊路径，特别是用于仓库提交信息的路径，解决了嵌套URL问题：

```
/用户名/仓库名/latest-commit/分支名/https://gh.域名/...
```

这类路径会被正确截断并转发到GitHub。

## 安全考虑

- 代理服务不存储或处理用户凭据
- 敏感路径（如登录页面）会被重定向到其他网站
- 所有流量都通过HTTPS加密

## 限制

- 不支持GitHub的登录和注册功能
- 某些高级GitHub功能可能不完全兼容
- 不能代替GitHub CLI或Git等工具的直接连接

## 故障排除

如果遇到问题：

1. 确认DNS记录配置正确
2. 检查Worker是否正常运行
3. 尝试清除浏览器缓存
4. 检查请求和响应日志以获取详细错误信息

## 贡献指南

欢迎提交Pull Request或Issue来改进此项目。特别欢迎以下方面的贡献：

- 增加对更多GitHub相关域名的支持
- 改进内容替换逻辑
- 增强错误处理机制
- 添加性能优化

## 免责声明

此代理服务仅用于教育和研究目的。使用者应确保遵守GitHub的服务条款和当地法律法规。

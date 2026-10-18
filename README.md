# 开口英语

可自托管的英语听说练习网页程序，支持逐句原音、变速听力、录音回听、复习安排、学习记录和情景语音对话。包含适配 iPad 的界面、PWA 离线缓存和同源 AI 接口；Node24 服务无 npm 运行依赖。

## 许可与排除范围

程序、界面、图标和自托管代码采用 [MIT License](LICENSE)，版权标记为 `Copyright (c) 2026 ouzingzhi-cell`。

以下内容**不包含在本仓库中，也不受本仓库 MIT 授权覆盖**：

- 20课教材全文、对话正文及其翻译、对齐数据；
- 100段原音及环境录音；
- 用户学习记录、用户录音、浏览器资料和缓存；
- 真实 API Key、Cloudflare 凭据、部署账号资料和本地环境配置。

使用者需要自行准备有权使用的教材与音频。测试只使用虚构文本和运行时生成的字节，不提供教材或录音样例。请勿把私人资料和无权公开的课程内容提交到仓库。

## 运行与测试

要求 Node24 或更新版本，无需执行 `npm install`。

```sh
npm test
```

测试覆盖 API 模拟调用、移动语音控制和 Node 服务的路径、Origin、上传限制、取消、HEAD及Range/If-Range行为，不会调用付费 AI。依赖完整教材的页面和离线安装验收需要另行接入有授权的资源。

```sh
cp .env.example .env
# 编辑 PUBLIC_ORIGIN；公网使用实际 HTTPS 来源。
node --env-file=.env server.mjs
```

本机可设置 `PUBLIC_ORIGIN=http://127.0.0.1:5193`、`PORT=5193` 后启动，访问 `http://127.0.0.1:5193/studio/`。部署时使用真实HTTPS来源，Node默认仅监听回环地址。

仓库提供 Dockerfile、Compose 和 Caddy 配置。使用 Compose 时，将 `.env` 的 `SITE_ADDRESS` 设为域名，`PUBLIC_ORIGIN` 设为对应HTTPS来源，再运行 `docker compose up --build -d`。请自行配置域名、证书、防火墙，并确认托管费用与适用的备案要求。iPad录音、离线缓存及添加主屏幕需要HTTPS。

**仓库不包含课程资源，直接启动后会提示教材未准备好。** 应用需要的课程JSON与音频路径可从程序的资源加载和Service Worker清单查看；接入有授权的资源后，再验证完整页面、离线安装和录音。

## 网络与存储限制

AI仍依赖OpenAI语音识别与朗读；DeepSeek模式也需单独的OpenAI语音Key。MIT许可和公益域名不代表AI免费或全链路国内网络可用。API Key仅留在本页内存及当次请求中，不应写入仓库或服务器环境文件。

默认学习存储采用独立的 `kaikou-ipad-v1`。更换域名时，浏览器将使用新的来源存储，请先导出学习记录。

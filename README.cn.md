[English](README.md) | [Русский](README.ru.md) | **中文**

# mercurius-browser

[Mercurius](https://github.com/opencck/mercurius) 智能体的浏览器：Debian 自带的 Chromium，由 puppeteer-core 驱动，
前面是一个小型 Fastify API。它是 Mercurius 的一个模块，也可以单独使用。没有它智能体照样能工作，
只是没有 `browser` 工具。

## API

除 `/health` 外，每个路由都需要 `Authorization: Bearer <BROWSER_TOKEN>`。请求体为 JSON；`profile`（默认 `main`）
指定一个配置文件，其中的登录状态在重启后依然保留（`[a-z0-9][a-z0-9_-]{0,31}`）。

| 路由 | 作用 |
|---|---|
| `GET /health` | `{"ok": true, "sessions": N}` |
| `POST /navigate` | 打开一个 URL |
| `POST /read` | 页面文本及其链接和输入字段 |
| `POST /click`, `POST /type` | 对元素执行操作；`type` 只写入文本字段，换行按文本写入，只有 `submit` 才会提交 |
| `POST /select` | 按值、按文本，或按仅有一个选项包含的部分文本来选择列表中的选项 |
| `POST /scroll` | 向下（`down`）、向上（`up`）滚动，或滚动到顶部（`top`）或底部（`bottom`） |
| `POST /back` | 在页面历史中后退 |
| `POST /evaluate` | 运行脚本：在冻结的离线副本上读取，或在实时页面上操作 |
| `POST /screenshot` | 页面的 PNG 截图 |
| `POST /close` | 关闭该配置文件的页面 |
| `POST /adopt` | 把旧的扁平结构的配置文件移入所有者的集合（`{"owner":"p1"}`），登录状态保留 |

页面的对话框（`alert`、`confirm`、`prompt`、`beforeunload`）会被立即关闭，其文本随下一次响应一并返回（`dialogs`）：打开的对话框会卡住页面。页面打开的新标签页会成为当前标签页。

页面的每个请求都会对照内部地址和私有地址进行检查（`src/guard.ts`），并通过一个环回代理发出，该代理连接的是已检查过的地址（`src/proxy.ts`），因此页面无法触及主机的网络。会话在 10 分钟没有请求后关闭。

## 设置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `BROWSER_TOKEN` | — | 必填，至少 16 个字符 |
| `PORT` | `3000` | 端口 |
| `PROFILES_DIR` | `/profiles` | 保存带登录状态的配置文件的位置：`p<participant>/<name>`、`p<participant>/projects/<project>/<name>` |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | 浏览器 |

## 运行

```sh
docker build -t mercurius-browser .
docker run --rm --shm-size=512m -e BROWSER_TOKEN=$(openssl rand -hex 32) -p 3000:3000 mercurius-browser
```

在 Mercurius 中，该服务位于 compose 配置 `browser` 下：把它加入 `COMPOSE_PROFILES`，并在 `.env` 中设置 `BROWSER_TOKEN`。

## 开发

该服务用 TypeScript（Node.js 22）编写：源码在 `src/`（`server.ts` — API，`guard.ts` — 地址检查和辅助函数，`proxy.ts` — 环回代理），测试在 `test/`。`tsc` 把二者一起编译到 `dist/`；
Docker 镜像在单独的阶段构建它们，并运行 `dist/src/server.js`。

```sh
npm install
npm run build    # compile into dist/
npm start        # run dist/src/server.js
npm run check    # TypeScript type check, ESLint and the tests
```

测试不需要浏览器，也不需要网络（代理测试会在环回地址上打开套接字）。CI 运行 `npm ci` 和
`npm run check`。

## 许可证

MIT

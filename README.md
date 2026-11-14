# QB囤 · 安卓版（QBtunApk）

把桌面版 `QB囤桌面版.exe` 的整套功能搬到 Android：**原生 WebView 壳 + 同源页面复用**。
桌面版 0.0.1 / 0.0.2 未改动，本仓库是独立项目（`yin-hush/QBtunApk`），与 GBO 的 `Gboapk` 仓库互不相干。

## 为什么不用本地服务器

桌面版靠 Python 反向代理把 `/__gui`、`/__tool` 注入同一个域。安卓上没有 Python 服务，
改用 `WebViewClient.shouldInterceptRequest`：只把下面几个虚拟路径替换成 APK 内置 assets，
其余请求（含原网页 `/`、全部 `/api/*`）一律原样走网络。

| 虚拟路径 | 来源 |
|---|---|
| `/__gui` | `assets/gui.html` 主面板 |
| `/__tool` | `assets/console.html` 批量控制台 |
| `/__app.js` | `assets/app.js` 运行时（登录 / 统计 / 账单） |
| `/__api` | `assets/qb_config.json` 站点与接口映射 |

于是页面地址仍是 `https://站点/__gui`，与接口**同源**：Cookie 由 WebView 自动携带，
不需要 CORS 凭证、不需要应用内代理；原网页一字不改，两个页面共用同一份登录态。

## 功能

- **自动登录**：启动先用已保存的 CK 请求 `/api/me`；失效或为空则用配置里的账号密码调
  `/api/login`，WebView 自动写入新 CK。也可手动粘贴电脑上的 CK。
- **额度统计**：剩余总额度 / 已分配 / 未分配 / 已用额度（所有账号 `used` 合计），
  账单里额外记录 `历史总额度 = 剩余总额度 + 已用额度`。算法与桌面版 `server.py:quota_stats` 一致。
- **额度账单**：每次启动追加一行到 App 私有 `quota_log.txt`；账单栏只显示有效数据，
  支持「全部展示 / 精简展示」（精简 = 每天最后一条 + 历史总额度变动点及变动前一条）。
- **批量控制台**：批量发卡、改额度、改档位、改模式、改昵称，串行执行、带间隔、二次确认、结果汇总。
- **原网页**：单独标签，原封不动加载。
- **配置**：站点、用户名、密码、CK 都在 App 内填写；接口路径从 `qb_config.json` 读取，换站点只改配置不改代码。

## 构建

GitHub Actions（`.github/workflows/build-apk.yml`）在 push 到 `main` 时自动构建：
JDK 17 + Android SDK 34 + Gradle 8.9 → `app/build/outputs/apk/debug/app-debug.apk` → 上传 artifact。
纯 Android 框架 WebView，**无第三方依赖**。

本地构建（可选）：装 JDK 17、Android SDK platform-34 / build-tools 34.0.0 后运行 `gradle assembleDebug`。

签名：仓库内 `app/debug.keystore` 是固定的**调试**密钥（PKCS12，密码 `qbtun2026`），
保证每次 CI 出的包签名一致，可直接覆盖安装。**这不是正式发布密钥，请勿用于上架。**

## 首次使用

1. 安装 APK（系统需允许「安装未知来源应用」）。
2. 打开 App → 点「配置」→ 填用户名和密码 → 「保存并重新登录」。
3. 回到主面板看额度；「批量控制台」标签里勾选账号执行批量操作。
4. 想用电脑上已有的会话，可把 `tunji_webdesk=...` 粘到「CK」一栏。

## 网络注意事项（重要）

目标域名只有 **AAAA（IPv6）记录，没有 IPv4**。手机用**蜂窝流量**时运营商原生支持 IPv6，
App 可直连；连到不给 IPv6 的 WiFi（例如校园网、手机热点共享给电脑那种情形）就会连不上，
需要手机侧开全局 VPN/代理，或请服务方补一个 IPv4 入口。桌面版之所以走 `127.0.0.1:7897` 代理，
原因正是这个；安卓版不做应用级代理，靠系统网络栈。

## 隐私

- 仓库与 APK **不含任何账号、密码或 CK**；`qb_config.json` 只有站点地址和接口路径。
- 用户填的账号密码存 App 私有 `localStorage`，CK 存 `CookieManager`，
  账单存 App 私有文件，普通应用读不到。
- `app/debug.keystore` 是自签调试密钥，公开无妨，但别拿它签正式发布包。

## 仓库维护：上传办法（沿用 GBO 项目）

不用本机 git、不用 gh CLI、不用网页上传，走 **GitHub REST Git Data API**：

1. 令牌：环境变量 `GHPAT`，classic PAT 必须带 **`workflow` scope**（只勾 `repo` 时写
   `.github/workflows/` 会被 API 拒）；出网走 `127.0.0.1:7897` 代理。
2. 每个文件 `POST /git/blobs`（`content` 为 base64，二进制 keystore 也一样）。
3. `POST /git/trees`，更新时带 `base_tree`（当前 `refs/heads/main` 的 sha）。
4. `POST /git/commits` → `PATCH /git/refs/heads/main`（首次创建用 `POST /git/refs`）。
   所有文件合成**一个 commit**，只触发一次 CI，避免连跑好几个构建。
5. **全新空仓库**的 Git Data API 会报 `409 Git Repository is empty`：先调一次
   Contents API `PUT /contents/README.md` 造初始 commit（此时还没有 workflow 文件，
   不会触发 CI），再按上面步骤推送。

配套脚本在本地 `_local/`（`push.py` / `gh.py` / `poll.py` / `download.py`），
被 `.gitignore` 排除、不入库；`poll.py` 轮询 run，`download.py` 用「先取 302 Location、
再无 auth 下载」两步取回制品 APK 并校验签名。


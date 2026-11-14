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
- **额度账单**：**2 小时内最多写一条**（2h 内已有任何日志就跳过），避免频繁启动把文件写爆；
  桌面版 0.0.2 的 `server.py:write_bill` 是同一规则。主面板第三标签用**表格**展示
  有效数据（列为 时间 / 剩余总额度 / 已分配 / 未分配 / 已用额度 / 历史总额度），
  支持「全部展示 / 精简展示」（精简 = 每天最后一条 + 历史总额度变动点及变动前一条），
  窄屏可横向滚动。桌面版 0.0.2 的账单栏同样是表格。
- 额度统计**只显示在批量控制台顶部**（主面板顶部不再重复一组，避免同屏出现两遍）。
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

## v1.0.3 修复（安卓批量按钮无响应）
- 症状：所有批量按钮点了没反应。根因是 WebView 默认**不显示 JS 对话框**，
  `confirm()` 恒返回 false、`alert()` 静默消失，而每个批量操作都先走 `confirmRun()`。
- 修法：`MainActivity` 设置 `WebChromeClient`，用原生 `AlertDialog` 接管
  `onJsConfirm` / `onJsAlert` 并回调 `JsResult`；同时把 JS console 输出到 Logcat 便于排查。
- 桌面版浏览器有原生 alert/confirm，不受此问题影响，无需改动这一处。

## 版本更新与覆盖安装（v1.0.1+）

- **签名固定**：`app/debug.keystore` 提交在仓库，`app/build.gradle` 的 `signingConfigs.qbtun`
  直接引用它；CI 每次 checkout 同一把钥匙，产物证书 SHA256 恒为
  `8d4013798b5331866a84bba9753c9902f4231d8676e443ee2a0fa6950ba8dd5d`。
- **versionCode 单调递增**（1 → 2 → 3 → 4 → …），避免 `INSTALL_FAILED_VERSION_DOWNGRADE`。
- 覆盖安装三条件：同包名 `com.yinhush.qbtun` + 同签名证书 + versionCode 不降级。
  v1.0.0 与 v1.0.1 用的是同一把钥匙，**可直接覆盖安装，不需要先卸载**。
- 校验方法：`_local/download.py` 会比对签名证书 DER 是否嵌在 APK Signing Block 里；
  也可用 `aapt2 dump badging <apk>` 看 versionCode。
- GBO 项目早期踩过的坑（不要再犯）：CI 每次新环境现生成随机 `~/.android/debug.keystore`，
  后来 `actions/cache` 又把缓存里的随机钥匙覆盖回工作区 → 每次签名证书不同 →
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，必须卸载重装。根治是把固定 keystore 提交进仓库、
  构建后 `zipalign` + `apksigner sign --ks` 强制重签并打印指纹核对；
  用旧随机钥匙装过的包需要**先卸载一次**，之后同钥匙才能永久覆盖安装。

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

配套脚本在本地 `_local/`（`push.py` / `gh.py` / `poll.py` / `download.py` / `verify_sign.py`），
被 `.gitignore` 排除、不入库；`poll.py` 轮询 run，`download.py` 用「先取 302 Location、
再无 auth 下载」两步取回制品 APK 并校验签名，`verify_sign.py` 判定新旧包能否覆盖安装。

调用顺序（在本目录执行，无需本机 git）：

```bash
python _local/push.py                    # 推送全部文件，输出完整 SHA；可传自定义 commit message
python _local/poll.py <完整SHA>          # 等 BUILD_DONE success，拿 RUN_ID
python _local/download.py <RUN_ID>       # 下载并校验 APK，覆盖项目根 QB囤安卓版.apk
python _local/verify_sign.py             # 与 _local/QB囤安卓版_1.0.0.apk 比对，判定可覆盖安装
python _local/push.py "docs: ... [skip ci]"   # 只改文档，不触发构建
```


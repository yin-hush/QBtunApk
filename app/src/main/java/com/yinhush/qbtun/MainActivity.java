package com.yinhush.qbtun;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * QB囤 安卓版：一个原生 WebView 壳。
 *
 * 思路与桌面版一致——「原网页原封不动 + 同域二级页面」。
 * 桌面版靠 Python 反向代理把 /__gui、/__tool 注入同一个域；安卓版没有本地服务，
 * 改用 shouldInterceptRequest 把这几个路径替换成本地 assets，其余请求原样走网络。
 * 因此页面 URL 仍是 https://站点/__gui，与 /api/* 天然同源，Cookie 由 WebView
 * 自动携带，不需要 CORS、不需要跨域凭证、也不需要应用内代理。
 *
 * 账号密码/CK 不写进代码，由使用者在页面「配置」里填写，存于 localStorage +
 * WebView CookieManager；账单写到 App 私有目录：
 *   quota_log.txt  额度账单（纯文本行）
 *   qb.log         Q币账单（JSON Lines，按账号分类累积充值记录）
 * 两个账单都支持导入/导出：用 SAF(ACTION_CREATE_DOCUMENT / ACTION_OPEN_DOCUMENT)
 * 让用户自己选文件位置，不需要申请存储权限，也无需读写外部存储。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "qbtun";
    private static final String KEY_SITE = "site";
    private static final String BILL_FILE = "quota_log.txt";
    private static final String QB_FILE = "qb.log";
    private static final String DEFAULT_SITE = "https://tj.2.wffwff.cn:6789";

    private static final int REQ_EXPORT = 1001;
    private static final int REQ_IMPORT = 1002;
    private static final int MAX_IMPORT_BYTES = 8 * 1024 * 1024;  // 导入文件上限，避免 OOM
    // 检查更新
    private static final String UPDATE_API = "https://api.github.com/repos/yin-hush/QBtunApk/releases/latest";
    private static final String UPDATE_PAGE = "https://github.com/yin-hush/QBtunApk/releases/latest";
    private final ExecutorService netPool = Executors.newSingleThreadExecutor();
    private DownloadManager dlManager;
    private final BroadcastReceiver downloadDone = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (dlManager == null || id < 0) return;
            DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
            android.database.Cursor cur = dlManager.query(q);
            try {
                if (cur == null || !cur.moveToFirst()) return;
                int status = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_STATUS));
                if (status != DownloadManager.STATUS_SUCCESSFUL) { toast("更新包下载失败"); return; }
                String local = cur.getString(cur.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI));
                if (local == null) { toast("更新包路径获取失败"); return; }
                Uri apk = Uri.parse(local);
                Intent ins = new Intent(Intent.ACTION_VIEW);
                ins.setDataAndType(apk, "application/vnd.android.package-archive");
                ins.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { startActivity(ins); }
                catch (Exception e) { toast("无法弹安装：" + e.getMessage()); }
            } finally { if (cur != null) cur.close(); }
        }
    };

    private WebView web;
    private volatile String site;

    // SAF 导入导出的待处理数据（startActivityForResult 期间暂存）
    private String pendingExportName;
    private String pendingExportText;
    private String pendingImportKind;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        site = site();
        dlManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        try { registerReceiver(downloadDone, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)); }
        catch (Exception e) { Log.w("QBtun", "register download receiver failed: " + e.getMessage()); }

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage：配置与账单兜底
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "QBAndroid");

        // WebView 默认不显示 JS 对话框：confirm() 会恒返回 false、alert() 静默消失，
        // 批量按钮都先走 confirmRun()，于是全部「点了没反应」。必须用原生对话框接管。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                showJsDialog("确认操作", message, true, result);
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                showJsDialog("提示", message, false, result);
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d("QBWeb", cm.message() + " @" + cm.lineNumber() + " " + cm.sourceId());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return local(req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // 同站链接留在 WebView 内（原网页、工具页互相跳转）
                return false;
            }
        });

        web.loadUrl(site + "/__gui");
    }

    /** 把 JS 的 alert/confirm 映射成 Android 原生对话框，并必须回调 JsResult 解除 JS 阻塞。 */
    private void showJsDialog(final String title, final String message,
                              final boolean cancellable, final JsResult result) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                AlertDialog.Builder b = new AlertDialog.Builder(MainActivity.this)
                        .setTitle(title)
                        .setMessage(message)
                        .setPositiveButton(cancellable ? "确定" : "知道了",
                                new DialogInterface.OnClickListener() {
                                    @Override public void onClick(DialogInterface d, int w) {
                                        result.confirm();
                                    }
                                });
                if (cancellable) {
                    b.setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        @Override public void onClick(DialogInterface d, int w) {
                            result.cancel();
                        }
                    });
                }
                b.setOnCancelListener(new DialogInterface.OnCancelListener() {
                    @Override public void onCancel(DialogInterface d) { result.cancel(); }
                });
                try {
                    b.show();
                } catch (Exception e) {
                    // Activity 已销毁时别把 JS 线程卡死
                    result.cancel();
                }
            }
        });
    }

    /** 站点默认取 assets/qb_config.json，用户可在「配置」里覆盖。 */
    private String site() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = p.getString(KEY_SITE, "");
        if (saved != null && saved.startsWith("http")) return trimSlash(saved);
        try {
            JSONObject j = new JSONObject(readAsset("qb_config.json"));
            String s = j.optString("site", DEFAULT_SITE);
            if (s.startsWith("http")) return trimSlash(s);
        } catch (Exception ignored) {}
        return DEFAULT_SITE;
    }

    private static String trimSlash(String s) {
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** 只替换本站的几个虚拟路径，其它一律放行走网络（保证原网页原封不动）。 */
    private WebResourceResponse local(WebResourceRequest req) {
        try {
            Uri u = req.getUrl();
            Uri base = Uri.parse(site);
            if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
            if (!base.getHost().equalsIgnoreCase(u.getHost())) return null;
            if (base.getPort() != u.getPort()) return null;
            String p = u.getPath();
            if (p == null) return null;
            if (p.equals("/__gui") || p.equals("/__gui/")) return asset("text/html", "gui.html");
            if (p.equals("/__tool") || p.equals("/__tool/")) return asset("text/html", "console.html");
            if (p.equals("/__app.js")) return asset("application/javascript", "app.js");
            if (p.equals("/__api")) return json(apiJson());
        } catch (Exception ignored) {}
        return null;
    }

    private WebResourceResponse asset(String mime, String name) {
        try {
            return response(mime, getAssets().open(name));
        } catch (Exception e) {
            return null;
        }
    }

    private WebResourceResponse json(String text) {
        return response("application/json", new ByteArrayInputStream(
                text.getBytes(StandardCharsets.UTF_8)));
    }

    private WebResourceResponse response(String mime, InputStream in) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(mime, "UTF-8", 200, "OK", h, in);
    }

    /** 把当前站点写进下发的接口映射，换站点只改配置不改代码。 */
    private String apiJson() throws Exception {
        JSONObject j = new JSONObject(readAsset("qb_config.json"));
        j.put("site", site);
        return j.toString();
    }

    private String readAsset(String name) throws Exception {
        InputStream in = getAssets().open(name);
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        r.close();
        return sb.toString();
    }

    private File billFile() { return new File(getFilesDir(), BILL_FILE); }

    private synchronized String readBill() {
        StringBuilder sb = new StringBuilder();
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(
                    new FileInputStream(billFile()), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            r.close();
        } catch (Exception ignored) {}
        return sb.toString();
    }

    private synchronized void appendBill(String line) {
        if (line == null) return;
        try {
            FileOutputStream out = new FileOutputStream(billFile(), true);
            out.write((line.replace("\r", "").replace("\n", " ") + "\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {}
    }

    /** 导入额度账单用：原样追加多行，不做 2h 限流（限流在 JS 的常规写入路径上）。 */
    private synchronized void appendBillRaw(String text) {
        if (text == null || text.isEmpty()) return;
        try {
            FileOutputStream out = new FileOutputStream(billFile(), true);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {}
    }

    private File qbFile() { return new File(getFilesDir(), QB_FILE); }

    private synchronized String readQb() {
        StringBuilder sb = new StringBuilder();
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(
                    new FileInputStream(qbFile()), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            r.close();
        } catch (Exception ignored) {}
        return sb.toString();
    }

    /** 追加 JSON Lines（采集与导入合并都走这里）。 */
    private synchronized void appendQb(String text) {
        if (text == null || text.isEmpty()) return;
        try {
            FileOutputStream out = new FileOutputStream(qbFile(), true);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {}
    }

    /** 整体重写 qb.log（昵称同步用：只改 note/id 字段，充值记录本身只增不删）。 */
    private synchronized void writeQb(String text) {
        try {
            FileOutputStream out = new FileOutputStream(qbFile(), false);
            if (text != null && !text.isEmpty()) out.write(text.getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {}
    }

    // ─────────────── SAF 导入 / 导出 ───────────────

    /** 导出：调系统「另存为」，用户选位置后写入账单原文。 */
    private void startExport(final String name, final String text) {
        pendingExportName = name;
        pendingExportText = text;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    startActivityForResult(i, REQ_EXPORT);
                } catch (Exception e) {
                    toast("无法打开保存界面：" + e.getMessage());
                }
            }
        });
    }

    /** 导入：调系统文件选择器，读回文本后回调 JS 的 QB.onImportResult(kind, text)。 */
    private void startImport(final String kind) {
        pendingImportKind = kind;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(i, REQ_IMPORT);
                } catch (Exception e) {
                    toast("无法打开文件选择器：" + e.getMessage());
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            toast("已取消");
            return;
        }
        Uri uri = data.getData();
        if (requestCode == REQ_EXPORT) {
            writeToUri(uri, pendingExportText);
            pendingExportText = null;
        } else if (requestCode == REQ_IMPORT) {
            String text = readFromUri(uri);
            final String kind = pendingImportKind == null ? "qb" : pendingImportKind;
            pendingImportKind = null;
            if (text == null) {
                toast("读取文件失败或文件过大（上限 8MB）");
                return;
            }
            deliverImport(kind, text);
        }
    }

    private void writeToUri(Uri uri, String text) {
        if (text == null) text = "";
        try {
            OutputStream out = getContentResolver().openOutputStream(uri);
            if (out == null) throw new Exception("openOutputStream returned null");
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.close();
            toast("已导出 " + pendingExportName);
        } catch (Exception e) {
            toast("导出失败：" + e.getMessage());
        }
    }

    private String readFromUri(Uri uri) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return null;
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int n;
            while ((n = in.read(tmp)) != -1) {
                if (buf.size() + n > MAX_IMPORT_BYTES) { in.close(); return null; }
                buf.write(tmp, 0, n);
            }
            in.close();
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** 用 evaluateJavascript 把导入文本回传页面；JSONObject.quote 负责转义。 */
    private void deliverImport(final String kind, final String text) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    String js = "window.QB&&QB.onImportResult&&QB.onImportResult("
                            + JSONObject.quote(kind) + "," + JSONObject.quote(text) + ")";
                    web.evaluateJavascript(js, null);
                } catch (Exception e) {
                    toast("导入回传失败：" + e.getMessage());
                }
            }
        });
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private class Bridge {
        @JavascriptInterface
        public String readBill() { return MainActivity.this.readBill(); }

        @JavascriptInterface
        public void appendBill(String line) { MainActivity.this.appendBill(line); }

        @JavascriptInterface
        public void appendBillRaw(String text) { MainActivity.this.appendBillRaw(text); }

        @JavascriptInterface
        public String readQb() { return MainActivity.this.readQb(); }

        @JavascriptInterface
        public void appendQb(String text) { MainActivity.this.appendQb(text); }

        @JavascriptInterface
        public void writeQb(String text) { MainActivity.this.writeQb(text); }

        /** kind = "qb" | "quota"，仅用于导入时区分目标账单 */
        @JavascriptInterface
        public void exportText(String name, String content) { MainActivity.this.startExport(name, content); }

        @JavascriptInterface
        public void importText(String kind) { MainActivity.this.startImport(kind); }

        @JavascriptInterface
        public String getSite() { return site; }

        @JavascriptInterface
        public void setSite(final String url) {
            if (url == null || !url.startsWith("http")) return;
            final String clean = trimSlash(url.trim());
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SITE, clean).apply();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    site = clean;
                    web.loadUrl(site + "/__gui");
                }
            });
        }

        /** 允许从电脑复制 CK 粘进来；CK 失效后页面会自动用密码重登并覆盖它。 */
        @JavascriptInterface
        public void setCookie(String cookie) {
            if (cookie == null || !cookie.contains("=")) return;
            CookieManager cm = CookieManager.getInstance();
            cm.setCookie(site, cookie.split(";")[0].trim());
            cm.flush();
        }

        @JavascriptInterface
        public void flushCookies() { CookieManager.getInstance().flush(); }

        @JavascriptInterface
        public void copy(final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("QB囤", text));
                    Toast.makeText(MainActivity.this, "已复制", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 当前版本名（如 1.1.05），供页面比对 */
        @JavascriptInterface
        public String getVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) { return ""; }
        }

        /** 检查 GitHub 最新 Release，结果回调 window.QBUpdate.onCheck(...) */
        @JavascriptInterface
        public void checkUpdate() {
            netPool.execute(new Runnable() {
                @Override public void run() {
                    String tag = null, url = UPDATE_PAGE, err = null;
                    HttpURLConnection conn = null;
                    try {
                        conn = (HttpURLConnection) new URL(UPDATE_API).openConnection();
                        conn.setConnectTimeout(10000);
                        conn.setReadTimeout(10000);
                        conn.setRequestProperty("Accept", "application/vnd.github+json");
                        conn.setRequestProperty("User-Agent", "QBtun-Android");
                        int code = conn.getResponseCode();
                        if (code != 200) throw new Exception("HTTP " + code);
                        BufferedReader br = new BufferedReader(
                                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line);
                        br.close();
                        JSONObject j = new JSONObject(sb.toString());
                        tag = j.optString("tag_name", "");
                        JSONArray assets = j.optJSONArray("assets");
                        if (assets != null && assets.length() > 0) {
                            JSONObject a = assets.getJSONObject(0);
                            String dl = a.optString("browser_download_url", "");
                            if (!dl.isEmpty()) url = dl;
                        }
                    } catch (Exception e) {
                        err = e.getMessage() == null ? e.toString() : e.getMessage();
                    } finally {
                        if (conn != null) conn.disconnect();
                    }
                    final String fTag = tag, fUrl = url, fErr = err;
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            try {
                                JSONObject r = new JSONObject();
                                r.put("ok", fErr == null);
                                r.put("tag", fTag == null ? "" : fTag);
                                r.put("url", fUrl);
                                r.put("page", UPDATE_PAGE);
                                if (fErr != null) r.put("error", fErr);
                                String js = "window.QBUpdate&&window.QBUpdate.onCheck("
                                        + JSONObject.quote(r.toString()) + ")";
                                web.evaluateJavascript(js, null);
                            } catch (Exception e) {
                                toast("检查结果回传失败：" + e.getMessage());
                            }
                        }
                    });
                }
            });
        }

        /** 用系统浏览器打开更新页（浏览器下载） */
        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || !url.startsWith("http")) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Exception e) { toast("打开浏览器失败：" + e.getMessage()); }
                }
            });
        }

        /** 用系统 DownloadManager 下载 APK 到默认 Download 目录，完成后自动弹安装 */
        @JavascriptInterface
        public void downloadApk(final String url, final String name) {
            if (url == null || !url.startsWith("http")) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        if (dlManager == null) { toast("下载服务不可用"); return; }
                        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                        req.setTitle("QB囤安卓版更新");
                        req.setDescription(name == null ? "QBtun update" : name);
                        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                                name == null ? "QBtun-update.apk" : name);
                        req.setMimeType("application/vnd.android.package-archive");
                        dlManager.enqueue(req);
                        toast("已开始下载，完成后将提示安装");
                    } catch (Exception e) { toast("启动下载失败：" + e.getMessage()); }
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(downloadDone); } catch (Exception e) {}
        netPool.shutdownNow();
        super.onDestroy();
    }
}

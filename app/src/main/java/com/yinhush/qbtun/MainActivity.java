package com.yinhush.qbtun;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
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

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

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
 * WebView CookieManager；账单写到 App 私有目录 quota_log.txt。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "qbtun";
    private static final String KEY_SITE = "site";
    private static final String BILL_FILE = "quota_log.txt";
    private static final String DEFAULT_SITE = "https://tj.2.wffwff.cn:6789";

    private WebView web;
    private volatile String site;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        site = site();

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

    private class Bridge {
        @JavascriptInterface
        public String readBill() { return MainActivity.this.readBill(); }

        @JavascriptInterface
        public void appendBill(String line) { MainActivity.this.appendBill(line); }

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
}

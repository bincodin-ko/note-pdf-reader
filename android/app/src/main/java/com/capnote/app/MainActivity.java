package com.capnote.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/*
 * 안드로이드 껍데기.
 *
 * 하는 일은 데스크톱(Electron)과 같다 — public/ 의 화면을 창에 띄운다.
 * 다른 점은 AI다. 안드로이드에서는 Claude Code가 돌지 않으므로, 화면이
 * 멀리 있는 PC의 server.js에 정리를 부탁한다(주소·연결 코드는 화면에서 넣는다).
 *
 * 화면 파일은 앱 안에 담아 두고 가짜 주소(appassets.androidplatform.net)로
 * 연다. file:// 로 열면 IndexedDB(메모 저장소)를 못 쓰고, PC 주소로 열면
 * 집과 강의실에서 PC 주소가 달라질 때 메모가 둘로 갈라진다. 이 주소는 늘
 * 같으므로 메모가 한 곳에 쌓인다. 실제로 그 주소로 나가지는 않고 아래
 * shouldInterceptRequest에서 앱 안의 파일로 돌려준다.
 */
public class MainActivity extends Activity {

    static final String HOST = "appassets.androidplatform.net";
    static final String HOME = "http://" + HOST + "/index.html";
    static final int PICK_PDF = 7;

    WebView web;
    ValueCallback<Uri[]> pickCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage · IndexedDB — 메모가 여기 산다
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);         // 고른 PDF(content://)를 읽어야 한다
        // 화면 전체 확대는 끈다. 쪽 확대는 앱이 두 손가락으로 따로 한다
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        /*
         * 기기 글자 크기 설정이 앱 글자를 키우지 않게 한다. 키우면 위 줄 단추가
         * 넘쳐서 한 줄에 안 들어간다. 앱 안의 글자 크기는 가－/가＋가 맡는다.
         */
        s.setTextZoom(100);
        // 이 화면(http)이 PC(http)를 부르므로 섞인 내용 막기는 걸리지 않지만, 혹시 몰라 연다
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.addJavascriptInterface(new Bridge(), "CapnoteAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return asset(u.getPath());
                return null;                   // CDN(pdf.js)·PC 주소는 그대로 내보낸다
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // 바깥 링크는 브라우저로 연다. 앱 안에서 열리면 돌아올 길이 없다
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) { /* 열 앱이 없으면 그만 */ }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // "PDF 열기"를 누르면 안드로이드의 파일 고르기 창을 띄운다
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/pdf");
                try {
                    startActivityForResult(i, PICK_PDF);
                } catch (ActivityNotFoundException e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    // 앱 안에 담아 온 public/ 파일을 돌려준다
    WebResourceResponse asset(String path) {
        String p = (path == null || path.equals("/") || path.isEmpty()) ? "index.html" : path.substring(1);
        try {
            InputStream in = getAssets().open(p);
            return new WebResourceResponse(mime(p), "UTF-8", in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                    new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
    }

    static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != PICK_PDF || pickCallback == null) return;
        Uri[] got = null;
        if (result == RESULT_OK && data != null && data.getData() != null) {
            got = new Uri[]{data.getData()};
        }
        pickCallback.onReceiveValue(got);
        pickCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /*
     * 화면이 만든 파일(정리 PDF, 페이지 추출)을 다운로드 폴더에 쓴다.
     *
     * 웹뷰는 blob 주소를 내려받을 줄 몰라서 "내려받기"를 눌러도 아무 일이 없다.
     * 그래서 화면이 파일을 조각(base64)으로 나눠 넘기고 여기서 이어 쓴다.
     * 한 번에 넘기면 수십 MB짜리 PDF가 문자열 하나가 되어 버벅인다.
     */
    final class Bridge {
        final Map<String, Save> saves = new HashMap<>();
        int seq = 0;

        final class Save {
            Uri uri;
            OutputStream out;
            String name;
        }

        @JavascriptInterface
        public synchronized String saveBegin(String name, String mime) {
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                // 다 쓰기 전에는 다른 앱에 안 보이게 한다. 반쯤 쓴 PDF가 열리면 깨져 보인다
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "";
                Save sv = new Save();
                sv.uri = uri;
                sv.out = getContentResolver().openOutputStream(uri);
                sv.name = name;
                if (sv.out == null) return "";
                String id = "s" + (++seq);
                saves.put(id, sv);
                return id;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public synchronized boolean saveChunk(String id, String b64) {
            Save sv = saves.get(id);
            if (sv == null) return false;
            try {
                sv.out.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                drop(id);
                return false;
            }
        }

        @JavascriptInterface
        public synchronized String saveEnd(String id) {
            Save sv = saves.remove(id);
            if (sv == null) return "";
            try {
                sv.out.close();
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(sv.uri, v, null, null);
                final String msg = "다운로드 폴더에 저장했습니다: " + sv.name;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
                return Environment.DIRECTORY_DOWNLOADS + "/" + sv.name;
            } catch (Exception e) {
                return "";
            }
        }

        // 쓰다 실패한 것은 지운다. 반쪽짜리 파일이 다운로드 폴더에 남으면 헷갈린다
        void drop(String id) {
            Save sv = saves.remove(id);
            if (sv == null) return;
            try { sv.out.close(); } catch (Exception e) { /* 이미 닫혔다 */ }
            try { getContentResolver().delete(sv.uri, null, null); } catch (Exception e) { /* 그만 */ }
        }
    }
}

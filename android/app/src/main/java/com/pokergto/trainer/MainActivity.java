package com.pokergto.trainer;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 禁用 WebView 缩放（双指捏合 / 双击放大）：牌桌为固定布局的
        // 游戏界面，缩放飞出布局外只会造成误触。Web 端不受影响。
        WebView webView = getBridge().getWebView();
        webView.getSettings().setSupportZoom(false);
        webView.getSettings().setBuiltInZoomControls(false);
        webView.getSettings().setDisplayZoomControls(false);
    }
}

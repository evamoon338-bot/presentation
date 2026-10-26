package com.kwasuite.circle;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.browser.customtabs.CustomTabsCallback;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;

public final class MainActivity extends Activity {
    private static final String START_URL = "https://circle-app-9nh.pages.dev/";
    private static final String CHROME_PACKAGE = "com.android.chrome";
    private static final int CIRCLE_COLOR = Color.rgb(243, 245, 247);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private CustomTabsSession session;
    private boolean launched;
    private boolean bound;

    private final CustomTabsServiceConnection connection =
            new CustomTabsServiceConnection() {
                @Override
                public void onCustomTabsServiceConnected(
                        android.content.ComponentName name,
                        CustomTabsClient client) {
                    client.warmup(0L);
                    session = client.newSession(new CustomTabsCallback());
                    launchCircle();
                }

                @Override
                public void onServiceDisconnected(android.content.ComponentName name) {
                    session = null;
                }
            };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bound = CustomTabsClient.bindCustomTabsService(this, CHROME_PACKAGE, connection);
        if (!bound) {
            launchCircle();
            return;
        }
        handler.postDelayed(this::launchCircle, 1500L);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (bound) {
            unbindService(connection);
            bound = false;
        }
        super.onDestroy();
    }

    private void launchCircle() {
        if (launched || isFinishing()) {
            return;
        }
        launched = true;
        handler.removeCallbacksAndMessages(null);

        Uri launchUri = Uri.parse(START_URL);
        try {
            if (session != null) {
                new TrustedWebActivityIntentBuilder(launchUri)
                        .setToolbarColor(CIRCLE_COLOR)
                        .setNavigationBarColor(CIRCLE_COLOR)
                        .build(session)
                        .launchTrustedWebActivity(this);
            } else {
                new CustomTabsIntent.Builder()
                        .setToolbarColor(CIRCLE_COLOR)
                        .build()
                        .launchUrl(this, launchUri);
            }
            finish();
        } catch (ActivityNotFoundException exception) {
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, launchUri);
            if (browserIntent.resolveActivity(getPackageManager()) != null) {
                startActivity(browserIntent);
                finish();
            }
        }
    }
}

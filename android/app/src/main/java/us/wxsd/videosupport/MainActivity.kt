package us.wxsd.videosupport

import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * Thin WebView shell for the device support form. Audio/video runs directly on
 * the configured RoomOS device after the backend dials it through Cloud xAPI,
 * so this WebView does not request camera or microphone access.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var trustedOrigin: Uri

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        trustedOrigin = Uri.parse(getString(R.string.support_page_url))
        webView = findViewById(R.id.web_view)
        configureWebView()

        webView.loadUrl(getString(R.string.support_page_url))
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        // Keep same-origin navigation inside the WebView and block unexpected
        // external origins from inheriting this app's camera/mic permissions.
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest
            ): Boolean = !isTrustedOrigin(request.url)
        }
    }

    private fun isTrustedOrigin(uri: Uri): Boolean =
        uri.scheme.equals(trustedOrigin.scheme, ignoreCase = true) &&
            uri.host.equals(trustedOrigin.host, ignoreCase = true) &&
            uri.port == trustedOrigin.port

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

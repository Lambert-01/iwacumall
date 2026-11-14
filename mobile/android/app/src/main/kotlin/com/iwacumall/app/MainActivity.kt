package com.iwacumall.app

import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity: FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.iwacumall.app/invoice")
            .setMethodCallHandler { call, result ->
                if (call.method != "openPdf") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                try {
                    val bytes = call.argument<ByteArray>("bytes")
                        ?: throw IllegalArgumentException("Invoice PDF bytes are missing.")
                    require(bytes.size >= 5 && String(bytes.copyOfRange(0, 5), Charsets.US_ASCII) == "%PDF-") {
                        "The invoice file is not a valid PDF."
                    }
                    val requestedName = call.argument<String>("fileName") ?: "IwacuMall-invoice.pdf"
                    val action = call.argument<String>("action") ?: "share"
                    val safeName = requestedName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
                    val invoiceDirectory = File(cacheDir, "invoices").apply { mkdirs() }
                    val expireBefore = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
                    invoiceDirectory.listFiles()?.filter { it.lastModified() < expireBefore }?.forEach { it.delete() }
                    val invoiceFile = File(invoiceDirectory, safeName)
                    invoiceFile.writeBytes(bytes)
                    val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.fileprovider", invoiceFile)
                    val pdfIntent = if (action == "open") {
                        Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/pdf")
                            clipData = ClipData.newUri(contentResolver, safeName, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                    } else {
                        Intent(Intent.ACTION_SEND).apply {
                            type = "application/pdf"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            clipData = ClipData.newUri(contentResolver, safeName, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                    }
                    val chooserTitle = if (action == "open") "Open invoice PDF" else "Share invoice PDF"
                    startActivity(Intent.createChooser(pdfIntent, chooserTitle))
                    result.success(true)
                } catch (error: Exception) {
                    result.error("INVOICE_SHARE_FAILED", error.message ?: "Could not open invoice sharing.", null)
                }
            }
    }
}

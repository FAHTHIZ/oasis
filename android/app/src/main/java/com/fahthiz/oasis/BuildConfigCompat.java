package com.fahthiz.oasis;

import android.content.Context;

/** Reads the installed version without depending on generated BuildConfig. */
final class BuildConfigCompat {
    private BuildConfigCompat() {}

    static String version(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception error) {
            return "unknown";
        }
    }
}

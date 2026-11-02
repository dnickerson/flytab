package app.flywhere.flytab;

import java.security.MessageDigest;
import java.util.Collections;
import java.util.Set;

/**
 * May a downloaded APK be handed to the system installer as a FlyTab update?
 * Plain Java (no Android types): SftpPlugin.installApk reads both PackageInfos and
 * passes the values in; this decides. Every rule fails closed.
 */
public final class ApkCheck {
    private ApkCheck() {}

    /**
     * @param ownPackage          this app's package name
     * @param installedVersion    installed versionCode
     * @param installedSigners    SHA-256 (hex) of the installed app's signing certificates
     * @param apkPackage          the APK's package name, or null if Android could not read it
     * @param apkVersion          the APK's versionCode
     * @param apkSigners          SHA-256 (hex) of the APK's signing certificates
     * @return null if it may be installed, else why not (pilot-facing)
     */
    public static String refusal(String ownPackage, long installedVersion, Set<String> installedSigners,
                                 String apkPackage, long apkVersion, Set<String> apkSigners) {
        if (apkPackage == null) return "the file is not a readable Android app";
        if (ownPackage == null || !ownPackage.equals(apkPackage)) return "it is a different app (" + apkPackage + "), not FlyTab";
        Set<String> inst = installedSigners != null ? installedSigners : Collections.<String>emptySet();
        Set<String> apk = apkSigners != null ? apkSigners : Collections.<String>emptySet();
        if (inst.isEmpty() || apk.isEmpty()) return "its signature could not be read";
        if (!inst.equals(apk)) return "it is not signed with the same key as the installed FlyTab";
        if (apkVersion <= installedVersion) {
            return "it is not newer than the installed FlyTab (versionCode " + apkVersion + ", installed " + installedVersion + ")";
        }
        return null;
    }

    /** Lower-case hex SHA-256 of a certificate's DER bytes. */
    public static String sha256Hex(byte[] der) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}

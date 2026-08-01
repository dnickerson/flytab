#!/usr/bin/env bash
# FlyTab build script — builds APK and copies to repo root with version number
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
# APK always lands at the main repo root (works whether building from a
# worktree or the main checkout). --git-common-dir returns the main repo's
# .git in both cases; its parent is always the main repo root.
GIT_COMMON="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"
APK_DEST="$(cd "$REPO_ROOT" && cd "$(dirname "$GIT_COMMON")" && pwd)"

# Extract version from app.js
VERSION=$(grep -o "FLYTAB_VERSION = 'v[^']*'" "$REPO_ROOT/web/app.js" | grep -o "v[^']*")
APK_NAME="flytab-debug-${VERSION}.apk"

echo "=============================="
echo " FlyTab Build"
echo " Version: $VERSION"
echo "=============================="

# Sync versionCode/versionName in build.gradle from app.js version
VERSION_NUMERIC="${VERSION#v}"                          # e.g. "4.22"

# versionCode = major*100 + minor.
#
# The old rule was `tr -d '.'` (just delete the dot). That silently broke at the
# 9.99 -> 10.0 rollover: "10.0" became 100, which is LOWER than 9.99's 999, and
# Android rejects a lower versionCode as a downgrade ("cannot install this app").
# major*100+minor reproduces every historical code exactly (4.22 -> 422,
# 9.98 -> 998, 9.99 -> 999) while continuing to climb past the rollover
# (10.0 -> 1000, 10.1 -> 1001), so nothing already installed is disturbed.
VERSION_MAJOR="${VERSION_NUMERIC%%.*}"
VERSION_MINOR="${VERSION_NUMERIC#*.}"
[ "$VERSION_MINOR" = "$VERSION_NUMERIC" ] && VERSION_MINOR=0   # no dot, e.g. "10"
VERSION_MINOR="${VERSION_MINOR#0}"                              # "08" -> "8"
: "${VERSION_MINOR:=0}"

# The minor field MUST stay under 100 or versionCodes collide: v9.100 would give
# 9*100+100 = 1000, the same code as v10.0. Fail loudly rather than shipping an
# APK that silently refuses to install over its predecessor.
if ! [ "$VERSION_MAJOR" -ge 0 ] 2>/dev/null || ! [ "$VERSION_MINOR" -ge 0 ] 2>/dev/null; then
    echo "ERROR: cannot parse FLYTAB_VERSION '$VERSION' as major.minor" >&2
    exit 1
fi
if [ "$VERSION_MINOR" -ge 100 ]; then
    echo "ERROR: minor version $VERSION_MINOR must be < 100 (v$VERSION_MAJOR.$VERSION_MINOR would" >&2
    echo "       collide with v$((VERSION_MAJOR + 1)).0). Use two digits after the dot." >&2
    exit 1
fi
VERSION_CODE=$(( VERSION_MAJOR * 100 + VERSION_MINOR ))
sed -i "s/versionCode [0-9]*/versionCode $VERSION_CODE/" "$REPO_ROOT/android/app/build.gradle"
sed -i "s/versionName \"[^\"]*\"/versionName \"$VERSION_NUMERIC\"/" "$REPO_ROOT/android/app/build.gradle"
echo "[0] Version: $VERSION (code $VERSION_CODE) → build.gradle updated"

# Sync web assets into Android
echo ""
echo "[1] Syncing web assets..."
cd "$REPO_ROOT"
if command -v npx &>/dev/null; then
    npx cap sync android 2>&1 | tail -3
else
    echo "  npx not found — using rsync fallback"
    rsync -a --delete web/ android/app/src/main/assets/public/
    echo "  rsync: web/ → android/app/src/main/assets/public/"
fi

# Build APK
echo ""
echo "[2] Building APK..."
cd "$REPO_ROOT/android"
ANDROID_HOME=/home/dananickerson/Android/Sdk \
JAVA_HOME=/home/dananickerson/.gradle/jdks/eclipse_adoptium-21-amd64-linux.2 \
./gradlew assembleDebug 2>&1 | tail -5

# Copy to repo root with version name
echo ""
echo "[3] Copying APK..."
cp "app/build/outputs/apk/debug/app-debug.apk" "$APK_DEST/$APK_NAME"

# Remove old versioned APKs (keep only latest)
find "$APK_DEST" -maxdepth 1 -name "flytab-debug-v*.apk" ! -name "$APK_NAME" -delete 2>/dev/null || true

# Update flytab-latest.apk symlink for SFTP self-update
ln -sf "$APK_DEST/$APK_NAME" "$APK_DEST/flytab-latest.apk"

echo ""
echo "=============================="
echo " Done!"
echo " APK: $APK_NAME"
echo " Latest: $APK_DEST/flytab-latest.apk → $APK_NAME"
echo "=============================="

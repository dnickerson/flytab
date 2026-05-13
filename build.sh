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
VERSION_CODE=$(echo "$VERSION_NUMERIC" | tr -d '.')    # e.g. "422"
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

echo ""
echo "=============================="
echo " Done!"
echo " APK: $APK_NAME"
echo "=============================="

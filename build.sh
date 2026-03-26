#!/usr/bin/env bash
# FlyTab build script — builds APK and copies to data/ with version number
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"

# Extract version from app.js
VERSION=$(grep -o "FLYTAB_VERSION = 'v[^']*'" "$REPO_ROOT/flytab/web/app.js" | grep -o "v[^']*")
APK_NAME="flytab-debug-${VERSION}.apk"

echo "=============================="
echo " FlyTab Build"
echo " Version: $VERSION"
echo "=============================="

# Sync web assets into Android
echo ""
echo "[1] Syncing web assets..."
cd "$REPO_ROOT/flytab"
npx cap sync android 2>&1 | tail -3

# Build APK
echo ""
echo "[2] Building APK..."
cd "$REPO_ROOT/flytab/android"
ANDROID_HOME=/home/dananickerson/Android/Sdk \
JAVA_HOME=/home/dananickerson/.gradle/jdks/eclipse_adoptium-21-amd64-linux.2 \
./gradlew assembleDebug 2>&1 | tail -5

# Copy to data/ with version name
echo ""
echo "[3] Copying APK..."
mkdir -p "$DATA_DIR"
cp "app/build/outputs/apk/debug/app-debug.apk" "$DATA_DIR/$APK_NAME"

# Remove old versioned APKs (keep only latest)
find "$DATA_DIR" -name "flytab-debug-v*.apk" ! -name "$APK_NAME" -delete 2>/dev/null || true

echo ""
echo "=============================="
echo " Done!"
echo " APK: data/$APK_NAME"
echo "=============================="

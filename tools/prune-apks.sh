#!/usr/bin/env bash
# Keep the APK just built plus the N highest earlier versions (default 5) in DIR, so the
# pilot can go back to a previous version. Called by build.sh.
#
#   tools/prune-apks.sh DIR CURRENT_APK_NAME [KEEP_PREVIOUS] [--dry-run]
#
# Only files named flytab-debug-v<major>.<minor>.apk are candidates; anything else (the
# flytab-latest.apk link, odd names) is never touched. Versions are ordered by the same
# versionCode build.sh uses (major*100 + minor), so v12.9 < v12.10 < v12.70.
set -euo pipefail

DIR="${1:?usage: prune-apks.sh DIR CURRENT_APK_NAME [KEEP_PREVIOUS] [--dry-run]}"
CURRENT="${2:?usage: prune-apks.sh DIR CURRENT_APK_NAME [KEEP_PREVIOUS] [--dry-run]}"
KEEP=5
DRY=0
for arg in "${@:3}"; do
    case "$arg" in
        --dry-run) DRY=1 ;;
        *[!0-9]*|'') echo "prune-apks: bad KEEP_PREVIOUS '$arg'" >&2; exit 1 ;;
        *) KEEP="$arg" ;;
    esac
done

[ -d "$DIR" ] || { echo "prune-apks: no directory $DIR" >&2; exit 1; }
[ -f "$DIR/$CURRENT" ] || { echo "prune-apks: $DIR/$CURRENT not found; nothing deleted" >&2; exit 1; }

# "<code> <name>" for every earlier versioned APK, highest version first
list=""
for path in "$DIR"/flytab-debug-v*.apk; do
    [ -f "$path" ] && [ ! -L "$path" ] || continue
    name="$(basename "$path")"
    [ "$name" = "$CURRENT" ] && continue
    if [[ "$name" =~ ^flytab-debug-v([0-9]+)\.([0-9]+)\.apk$ ]]; then
        code=$(( 10#${BASH_REMATCH[1]} * 100 + 10#${BASH_REMATCH[2]} ))
        list+="$code $name"$'\n'
    fi
done

n=0
while read -r code name; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ]; then
        echo "  keep   $name"
    elif [ "$DRY" = 1 ]; then
        echo "  would delete $name"
    else
        rm -f -- "$DIR/$name"
        echo "  delete $name"
    fi
done < <(printf '%s' "$list" | sort -rn -k1,1)

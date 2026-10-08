#!/usr/bin/env bash
# EdcWatch uzantısından Safari için (Mac + iPad) bir Xcode projesi üretir.
#
#   ./scripts/make-safari-app.sh https://edcwatch.KULLANICI.workers.dev
#
# Sunucu adresi uzantının içine varsayılan olarak gömülür; böylece iPad'de
# ayrıca bir ayar yapmak gerekmez. İsteğe bağlı: EDC_BUNDLE_ID=com.ornek.edcwatch
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${1:-${EDC_SERVER:-}}"
if [ -z "$SERVER" ]; then
  echo "Kullanım: ./scripts/make-safari-app.sh https://edcwatch.KULLANICI.workers.dev" >&2
  exit 1
fi
SERVER="${SERVER%/}"
case "$SERVER" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) echo "Uyarı: yerel adres yalnızca bu Mac'te çalışır, iPad bağlanamaz." >&2 ;;
  *) echo "Sunucu adresi https:// ile başlamalı (Safari düz http bağlantılarını engeller)." >&2; exit 1 ;;
esac

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode bulunamadı. App Store'dan ücretsiz Xcode'u kur, bir kez aç, sonra bunu tekrar çalıştır." >&2
  exit 1
fi

# Uygulama kimliği Apple hesabına göre benzersiz olmalı.
USER_PART="$(id -un | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
BUNDLE_ID="${EDC_BUNDLE_ID:-com.${USER_PART:-user}.edcwatch}"

rm -rf build/extension build/safari
mkdir -p build
cp -R extension build/extension
rm -f build/extension/icons/icon.svg build/extension/icons/icon-1024.png
cat > build/extension/config.js <<CONFIG
// scripts/make-safari-app.sh tarafından üretildi
self.EDC_CONFIG = { server: '$SERVER' };
CONFIG

xcrun safari-web-extension-converter build/extension \
  --project-location build/safari \
  --app-name EdcWatch \
  --bundle-identifier "$BUNDLE_ID" \
  --swift --copy-resources --no-prompt --no-open --force

PROJECT="$(find build/safari -maxdepth 2 -name '*.xcodeproj' | head -1)"
echo
echo "Hazır: $PROJECT"
echo "Sunucu: $SERVER   |   Bundle ID: $BUNDLE_ID"
open "$PROJECT" 2>/dev/null || true

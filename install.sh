#!/usr/bin/env bash

set -eux

# (Brave uses same path as Chrome, so for Brave, say `chrome`)
if [[ "$#" -lt 1 || (
          ! ( ( "$1" == "firefox" && "$#" -eq 1 ) ||
              ( "$1" == "chrome" && "$#" -eq 2 && ${#2} -eq 32 ) ||
              ( "$1" == "vivaldi" && "$#" -eq 2 && ${#2} -eq 32 ) ||
              ( "$1" == "chromebeta" && "$#" -eq 2 && ${#2} -eq 32 ) ||
              ( "$1" == "chromium" && "$#" -eq 2 && ${#2} -eq 32 ) ||
              ( "$1" == "edgedev" && "$#" -eq 2 && ${#2} -eq 32 ) ) ) ]]; then
    echo "Usage: $0 <chrome EXTENSION_ID | chromebeta EXTENSION_ID | chromium EXTENSION_ID | vivaldi EXTENSION_ID | edgedev EXTENSION_ID | firefox>"
    exit 2
fi
    
OS="$(uname -s)"
BROWSER="$(echo $1 | tr '[:upper:]' '[:lower:]')"

# https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests#Manifest_location
# https://developer.chrome.com/extensions/nativeMessaging#native-messaging-host-location
case "$OS $BROWSER" in
    "Linux firefox")
        MANIFEST_LOCATION="$HOME/.mozilla/native-messaging-hosts";;
    "FreeBSD firefox")
        MANIFEST_LOCATION="$HOME/.mozilla/native-messaging-hosts";;
    "Darwin firefox")
        MANIFEST_LOCATION="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts";;
    "Linux chrome")
        MANIFEST_LOCATION="$HOME/.config/google-chrome/NativeMessagingHosts";;
    "FreeBSD chromium")
        MANIFEST_LOCATION="$HOME/.config/chromium/NativeMessagingHosts";;
    "Linux chromium")
        MANIFEST_LOCATION="$HOME/.config/chromium/NativeMessagingHosts";;
    "Linux vivaldi")
        MANIFEST_LOCATION="$HOME/.config/vivaldi/NativeMessagingHosts";;
    "Linux edgedev")
        MANIFEST_LOCATION="$HOME/.config/microsoft-edge-dev/NativeMessagingHosts";;
    "Darwin chrome")
        MANIFEST_LOCATION="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts";;
    "Darwin chromebeta")
        MANIFEST_LOCATION="$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts";;
    "Darwin chromium")
        MANIFEST_LOCATION="$HOME/Library/Application Support/Chromium/NativeMessagingHosts";;
esac

mkdir -p "$MANIFEST_LOCATION"

APP_NAME="com.rsnous.tabfs"
EXE_PATH=$(pwd)/fs/tabfs

case "$BROWSER" in
    chrome | chromium | chromebeta | vivaldi | edgedev)
        EXTENSION_ID=$2
        MANIFEST=$(cat <<EOF
{
  "name": "$APP_NAME",
  "description": "TabFS",
  "path": "$EXE_PATH",
  "type": "stdio",
  "allowed_extensions": ["tabfs@rsnous.com"],
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
        );;
    firefox)
        MANIFEST=$(cat <<EOF
{
  "name": "$APP_NAME",
  "description": "TabFS",
  "path": "$EXE_PATH",
  "type": "stdio",
  "allowed_extensions": ["tabfs@rsnous.com"]
}
EOF
        );;
esac

echo "$MANIFEST" > "$MANIFEST_LOCATION/$APP_NAME.json"

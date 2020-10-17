EXE_PATH=$(shell pwd)/fs/tabfs
define NATIVE_MESSAGING_APP_MANIFEST
{
  "name": "com.rsnous.TabFS",
  "description": "TabFS",
  "path": "$(EXE_PATH)",
  "type": "stdio",
  "allowed_extensions": ["tabfs@rsnous.com"]
}
endef
export NATIVE_MESSAGING_APP_MANIFEST

#   "allowed_origins": [
#    "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/"
#  ]

# ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
MANIFEST_LOCATION="$$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
APP_NAME="com.rsnous.TabFS"
install:
# install native messaging json
	mkdir -p $(MANIFEST_LOCATION)
	echo "$$NATIVE_MESSAGING_APP_MANIFEST" > $(MANIFEST_LOCATION)/$(APP_NAME).json

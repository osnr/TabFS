## TabFS for Safari

This support is a work in progress (as are these instructions).

Safari's extension support is pretty messy. You will need:

- Xcode installed
- Safari 14 or newer
- macOS 10.15 Catalina or newer

Enable the Develop menu in Safari, then Develop -> Allow Unsigned
Extensions.

Open the Xcode project `TabFS/TabFS.xcodeproj` in this directory. Run
the project. It should open a TabFS app and install the extension in
Safari.

Enable the extension in Safari Preferences, grant it access to all
sites. It should be running now! (?)

Check the `fs/mnt` folder of the TabFS repo on your computer to see if
it's mounted.

### tips

- To open Web inspector: Safari -> Develop menu -> Web Extension
  Background Pages -> TabFS.

  Refreshing this inspector should reload the tabfs filesystem, also.

- You need to rebuild in Xcode any time you change background.js
  (because the extension files are copied into the extension, rather
  than running directly from folder as in Firefox and Chrome). This is
  pretty annoying.


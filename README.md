# tabfs

## Setup

You need to both install the Chrome extension and run the native
filesystem.

### Install the Chrome extension

Go to the [Chrome extensions page](chrome://extensions).

Enable Developer mode. Load-unpacked the `extension/` folder in this repo.

### Run the C filesystem

First, make sure you `git submodule update --init` to get the `mmx`
and `cJSON` dependencies. And make sure you have FUSE.

```
$ cd fs
$ mkdir mnt
$ make [unmount] mount
```

### Connect the browser extension to the filesystem

Once the filesystem is running and awaiting a WebSocket connection,
you need to tell the browser extension to connect to it.

Click the 'T' icon the extension put in your browser toolbar. The icon
badge should change from red to blue, and the filesystem program
should print that it's connected in the terminal.

Now your browser tabs should be mounted in `fs/mnt`!

## Design

- `extension/`: Browser extension, written in JS
- `fs/`: Native FUSE filesystem, written in C
  - `tabfs.c`: Main thread. Talks to FUSE, implements fs operations.
  - `ws.c`: Side thread. Runs WebSocket server. Talks to browser.
  - `common.c`: Communications interface between tabfs and ws.

When you, say, `cat` a file in the tab filesystem:

1. `cat` makes something like a `read` syscall,

2. which goes to the FUSE kernel module which backs that filesystem,

3. FUSE forwards it to the `tabfs_read` implementation in our
   userspace filesystem in `fs/tabfs.c`,

4. then `tabfs_read` rephrases the request as a JSON string and
   forwards it using `common_send_tabfs_to_ws` to `fs/ws.c`,

5. and `fs/ws.c` forwards it to our browser extension over WebSocket
   connection;

6. our browser extension in `extension/background.js` handles the
   incoming message and calls the browser APIs to construct the data
   for that synthetic file;

7. then the data gets sent back in a JSON message to `ws.c` and then
   back to `tabfs.c` and finally back to FUSE and the kernel and
   `cat`.

(very little actual work happened here, tbh. it's all just
marshalling)

TODO: make diagrams?

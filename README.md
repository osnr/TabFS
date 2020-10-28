# TabFS

## Setup

You need to compile the FUSE filesystem (written in C), then install
the browser extension which runs it and talks to it.

### Run the C filesystem

First, make sure you `git submodule update --init` to get the
`fs/cJSON` and `fs/base64` dependencies.

And make sure you have FUSE. On Linux, for example, `sudo apt install
libfuse-dev`. On macOS, get FUSE for macOS.

```
$ cd fs
$ mkdir mnt
$ make
```

Now install the native messaging host into your browser, so the
extension can launch and talk to the filesystem:

```
$ ./install.sh [chrome | chromium | firefox]
```

### Install the browser extension

I think it will work on Edge or Opera or whatever, too. You'll need to
change the native messaging path in install.sh

#### Firefox

#### Chrome

Go to the [Chrome extensions page](chrome://extensions).

Enable Developer mode. Load-unpacked the `extension/` folder in this repo.

Now your browser tabs should be mounted in `fs/mnt`!

## Design

- `extension/`: Browser extension, written in JS
- `fs/`: Native FUSE filesystem, written in C
  - `tabfs.c`: Talks to FUSE, implements fs operations, talks to browser.

When you, say, `cat` a file in the tab filesystem:

1. `cat` makes something like a `read` syscall,

2. which goes to the FUSE kernel module which backs that filesystem,

3. FUSE forwards it to the `tabfs_read` implementation in our
   userspace filesystem in `fs/tabfs.c`,

4. then `tabfs_read` rephrases the request as a JSON string and
   forwards it to the browser extension over 'native messaging',

6. our browser extension in `extension/background.js` handles the
   incoming message and calls the browser APIs to construct the data
   for that synthetic file;

7. then the data gets sent back in a JSON native message to `tabfs.c`
   and and finally back to FUSE and the kernel and `cat`.

(very little actual work happened here, tbh. it's all just
marshalling)

TODO: make diagrams?

## license

GPLv3

## hmm

it's way too hard to make an extension. even 'make an extension' is
a bad framing

open input space -- filesystem

now you have this whole 'language', this whole toolset, to control and
automate your browser

OSQuery

fake filesystems talk

Screenotate

processes as files. the real process is the browser. 

browser and Unix

rmdir a non-empty directory

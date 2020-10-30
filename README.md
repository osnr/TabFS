# TabFS

Mount your browser tabs as a filesystem.

## Examples of stuff you can do

(assuming your shell is in the `fs` subdirectory)

### List the titles of all the tabs you have open 

```
$ cat mnt/tabs/by-id/*/title
GitHub
Extensions
TabFS/install.sh at master · osnr/TabFS
Alternative Extension Distribution Options - Google Chrome
Web Store Hosting and Updating - Google Chrome
Home / Twitter
...
```

### Close all Stack Overflow tabs

```
$ echo close | tee -a mnt/tabs/by-title/*Stack_Overflow*/control
```

### Save text of all tabs to a file

(wip, FIXME)

```
$ cat mnt/tabs/by-id/*/text > text.txt
```

## Setup

First, install the browser extension.

Then, install the C filesystem.

### Install the browser extension

(I think it will work on Edge or Opera or whatever, too. You'll need to
change the native messaging path in install.sh in those cases.)

#### Chrome

Go to the [Chrome extensions page](chrome://extensions). Enable
Developer mode (top-right corner).

Load-unpacked the `extension/` folder in this repo.

Make a note of the extension ID. Mine is
`jimpolemfaeckpjijgapgkmolankohgj`. We'll use this later.

#### Firefox


### Install the C filesystem

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

#### Chrome and Chromium

Use the extension ID you copied earlier.

```
$ ./install.sh chrome jimpolemfaeckpjijgapgkmolankohgj
```

or

```
$ ./install.sh chromium jimpolemfaeckpjijgapgkmolankohgj
```

### Ready

Reload the extension in `chrome://extensions`.

Now your browser tabs should be mounted in `fs/mnt`!

Open the background page inspector (click "background page" next to
"Inspect views" in the extension's entry in the Chrome extensions
page) to see the filesystem operations stream in.

<img src="doc/inspector.png" width="600">

This console is also incredibly helpful for debugging anything that
goes wrong, which probably will happen.

(My OS and applications are pretty chatty! They do a lot of
operations, even when I don't feel like I'm actually doing anything.)

## Design

- `extension/`: Browser extension, written in JS
  - [`background.js`](extension/background.js): **The most interesting file**. Defines all the
    synthetic files and what browser operations they map to.
- `fs/`: Native FUSE filesystem, written in C
  - [`tabfs.c`](fs/tabfs.c): Talks to FUSE, implements fs operations, talks to extension.

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

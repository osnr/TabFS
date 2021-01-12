---
title: TabFS
meta: |
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@rsnous">
  <meta name="twitter:creator" content="@rsnous">
  <meta name="twitter:title" content="TabFS">
  <meta name="twitter:description" content="A browser extension that mounts your browser tabs as a filesystem on your computer.">
  <meta name="twitter:image" content="https://omar.website/projects/tabfs.png">
---
<!-- I'm setting this page in Verdana-on-gray so I feel more comfortable -->
<!-- jotting random notes and stuff down. -->
<style>
body { font-family: Verdana, sans-serif; background: #eee; }
h1 { font-family: Helvetica; }
#TableOfContents > ul > li:first-child { display: none; }
#TableOfContents a[rel=footnote] { display: none; }
pre { white-space: pre-wrap; }
</style>

[TabFS](https://github.com/osnr/TabFS) is a browser extension that
mounts your browser tabs as a filesystem on your computer.

Out of the box, it supports Chrome and (to a lesser extent[^firefox])
Firefox, on macOS and Linux.[^otherbrowsers]

(**update**: You can now **[sponsor further development of
TabFS](https://github.com/sponsors/osnr)** and help to turn it from an
experiment into something really reliable and useful!)

[^firefox]: because of the absence of the [chrome.debugger API for
    extensions](https://developer.chrome.com/docs/extensions/reference/debugger/).
    With a bit more plumbing, you could maybe find a way to connect it
    to the remote debugging protocol in Firefox and other browsers and
    get that second level of functionality that is currently
    Chrome-only.

[^otherbrowsers]: plus some related browsers and platforms: it also
    supports [Brave](https://github.com/osnr/TabFS/issues/30),
    Vivaldi, FreeBSD, etc. It could probably be made to work on other
    browsers like [Safari](https://github.com/osnr/TabFS/issues/6)
    that support the WebExtensions API, and [on Windows using Dokan or
    WinFUSE/WSL stuff (?)](https://github.com/osnr/TabFS/issues/13),
    but I haven't looked into that yet.

Each of your open tabs is mapped to a folder.

<div class="figure">
<a href="doc/00-browser.png"><img src="doc/00-browser.png" style="width: 70%"></a>
<a href="doc/00-finder.png"><img src="doc/00-finder.png" style="width: 80%; max-height: 1000px"></a>
<p class="caption" style="margin-top: -20px">I have 3 tabs open, and
they map to 3 folders in TabFS</p>
</div>

The files inside a tab's folder directly reflect (and can control) the
state of that tab in your browser. (TODO: update as I add more)

<div class="figure">
<video autoplay loop muted>
  <source src="doc/finder-contents.mp4" type="video/mp4">
</video>
<p class="caption">Example: the url.txt, text.txt, and title.txt
files inside a tab's folder, which tell me those live properties
for that tab</p>
</div>

This gives you a _ton_ of power, because now you can apply [all the
existing tools](https://twitter.com/rsnous/status/1018570020324962305)
on your computer that already know how to deal with files -- terminal
commands, scripting languages, point-and-click explorers, etc -- and
use them to control and communicate with your browser.

Now you don't need to [code up a browser extension from
scratch](https://twitter.com/rsnous/status/1261392522485526528) every
time you want to do anything. You can write a script that talks to
your browser in, like, a melange of Python and bash, and you can save
it as [a single ordinary
file](https://twitter.com/rsnous/status/1308588645872435202) that you
can run whenever, and it's no different from scripting any other part
of your computer.

### table of contents 

{{< table_of_contents >}}

## Examples of stuff you can do![^examples]

[^examples]: maybe some of these feel a little more vital and
    fleshed-out and urgent than others. the things I actually wanted
    to do and reached for vs. the things that satisfy some pedagogical
    property (simple to explain, stack on top of the previous example,
    ...)

(assuming your current directory is the `fs` subdirectory of the git
repo and you have the extension running)

### List the titles of all the tabs you have open 

```
$ cat mnt/tabs/by-id/*/title.txt
GitHub
Extensions
TabFS/install.sh at master · osnr/TabFS
Alternative Extension Distribution Options - Google Chrome
Web Store Hosting and Updating - Google Chrome
Home / Twitter
...
```

### Cull tabs like any other files 

<div class="figure">
<video autoplay loop muted>
  <source src="doc/delete.mp4" type="video/mp4">
</video>
<p class="caption">Selecting and deleting a bunch of tabs in my file manager</p>
</div>

I'm using Dired in Emacs here, but you could use whatever tools you
already feel comfortable managing your files with.

### Close all Stack Overflow tabs

```
$ rm mnt/tabs/by-title/*Stack_Overflow*
```

or (older / more explicit)

```
$ echo remove | tee -a mnt/tabs/by-title/*Stack_Overflow*/control
```

#### btw

(this task, removing all tabs whose titles contain some string, is a
little contrived, but it's not that unrealistic, right?)

(now... how would you do this _without_ TabFS?  I honestly have no
idea, off the top of my head. like, how do you even get the titles of
tabs? how do you tell the browser to close them?)

(I looked up the APIs, and, OK, if you're already in a browser
extension, in a 'background script' inside the extension, _and_ your
extension has the `tabs` permission -- this already requires you to
make 2 separate files and hop between your browser and your text
editor to set it all up! -- you can do
[this](https://developer.chrome.com/docs/extensions/reference/tabs/#method-query):
`chrome.tabs.query({}, tabs => chrome.tabs.remove(tabs.filter(tab =>
tab.title.includes('Stack Overflow')).map(tab => tab.id)))`)

(not _terrible_, but look at all that upfront overhead to get it set
up. and it's not all that discoverable. and what if you want to reuse
this later, or plug it into some larger pipeline of tools on your
computer, or give it a visual interface? the jump in complexity once
you need to communicate with anything -- possibly setting up a
WebSocket, setting up handlers and a state machine -- is pretty
horrifying)

(but to be honest, I wouldn't even have conceived of this as a thing I
could do in the first place)

### Save text of all tabs to a file

```
$ cat mnt/tabs/by-id/*/text.txt > text-of-all-tabs.txt
```

### Run script

```
$ echo 'document.body.style.background = "green"' > mnt/tabs/last-focused/execute-script
$ echo 'alert("hi!")' > mnt/tabs/last-focused/execute-script
```

### Get images / scripts / other resource files from page

(TODO: [document better](https://github.com/osnr/TabFS/issues/5), put in screenshots)

The [`debugger/`
subdirectory](https://github.com/osnr/TabFS/blob/fef9289e3a7f82cda6319d5f19d5a5f13f3cc44b/extension/background.js#L355)
in each tab folder has synthetic files that let you access loaded
resources (in `debugger/resources/`) and scripts (in
`debugger/scripts/`). 

Images will show up as actual PNG or JPEG files, scripts as actual JS
files, and so on. (this is experimental.)

(TODO: edit the images in place? you can already kinda edit the
scripts in place)

### Retrieve what's playing on YouTube Music: [youtube-music-tabfs](https://github.com/junhoyeo/youtube-music-tabfs)

[thanks](https://www.reddit.com/r/programming/comments/kok4dw/tabfs_mount_your_browser_tabs_as_a_filesystem/ghtbgw1/) to [Junho Yeo](https://github.com/junhoyeo)!

### Reload an extension when you edit its source code

Suppose you're working on a Chrome extension (apart from this
one). It's a pain to reload the extension (and possibly affected Web
pages) every time you change its code. There's a [Stack Overflow
post](https://stackoverflow.com/questions/2963260/how-do-i-auto-reload-a-chrome-extension-im-developing)
with ways to automate this, but they're all sort of hacky. You need
yet another extension, or you need to tack weird permissions onto your
work-in-progress extension, and you don't just get a command you can
trigger from your editor or shell to refresh the extension.

TabFS lets you do all this in [an ordinary shell
script](https://github.com/osnr/playgroundize-devtools-protocol/blob/main/go.sh).
You don't have to write any browser-side code at all.

This script turns an extension (this one's title is "Playgroundize
DevTools Protocol") off, then turns it back on, then reloads any tabs
that have the relevant pages open (in this case, I decided it's tabs
whose titles start with "Chrome Dev"):

```
#!/bin/bash -eux
echo false > mnt/extensions/Playg*/enabled
echo true > mnt/extensions/Playg*/enabled
echo reload | tee mnt/tabs/by-title/Chrome_Dev*/control
```

I mapped this script to Ctrl-. in my text editor, and now I just hit
that every time I want to reload my extension code.

### TODO: Live edit a running Web page

edit `page.html` in the tab folder. I guess it could just stomp
outerHTML at first, eventually could do something more sophisticated

then you can use your existing text editor! and you'll always know
that if the file saved, then it's up to date in the browser. no flaky
watcher that you're not sure if it's working

(it would be cool to have a persistent storage story here
also. I like the idea of being able to put arbitrary files anywhere in
the subtree, actually, because then you could use git and emacs
autosave and stuff for free... hmm)

### TODO: Watch expressions

```
$ touch mnt/tabs/last-focused/watches/window.scrollY
```

Now you can `cat window.scrollY` and see where you are scrolled on the
page at any time.

Could make an [ad-hoc
dashboard](https://twitter.com/rsnous/status/1080878682275803137)
around a Web page: a bunch of terminal windows floating around your
screen, each sitting in a loop and using `cat` to monitor a different
variable.

### TODO: Import data (JSON? XLS? JS?)

drag a JSON file `foo.json` into the `imports` subfolder of the tab
and it shows up as the object `imports.foo` in JS. (modify
`imports.foo` in JS and then read `imports/foo.json` and you read the
changes back?)

import a plotting library or whatever the same way? dragging
`plotlib.js` into `imports/plotlib.js` and then calling
`imports.plotlib()` to invoke that JS file

the browser has a lot of potential power as an interactive programming
environment, one where graphics come [as
naturally](https://twitter.com/rsnous/status/1295828978477932544) as
console I/O do in most programming languages. i think something that
holds it back that is underexplored is lack of ability to just... drag
files in and manage them with decent tools. many Web-based 'IDEs' have
to reinvent file management, etc from scratch, and it's like a
separate universe from the rest of your computer, and migrating
between one and the other is a real pain (if you want to use some
Python library to munge some data and then have a Web-based
visualization of it, for instance, or if you want to version files
inside it, or make snapshots so you [feel
comfortable](https://twitter.com/rsnous/status/1288725175895068673)
trying stuff, etc).

(what would the persistent storage story here be? localStorage? it's
interesting because I almost want each tab to be [less of a
commodity](https://twitter.com/rsnous/status/1344753559007420416),
less
[disposable](https://twitter.com/rsnous/status/1270192308772691968),
since now it's the site I'm dragging stuff to and it might have some
persistent state attached. like, if I'm programming and editing stuff
and saving inside a tab's folder, that tab suddenly really
[matters](https://twitter.com/rsnous/status/1251863115022491653); I
want it to survive as long as a normal file would, unlike most browser
tabs today)

(the combination of these last 3 TODOs may be a very powerful, open,
dynamic, flexible programming environment where you can bring whatever
external tools you want to bear, everything is live in your browser,
you never need to restart...)

## Setup

**disclaimer**: this extension is an experiment. I think it's cool and
useful and provocative, and I usually leave it on, but I make no
promises about functionality or, especially, security. applications
may freeze, your browser may freeze, there may be ways for Web pages
to use the extension to escape and hurt your computer ... In some
sense, the [whole
point](https://twitter.com/rsnous/status/1338932056743546880) of this
extension is to create a gigantic new surface area of communication
between stuff inside your browser and software on the rest of your
computer.

(The installation process is pretty involved right now. I'd like to
simplify it, but I also don't want a seamless installation process
that does a bad job of managing people's expectations. And it's
important to me that users [feel
comfortable](https://twitter.com/rsnous/status/1345113873792126976)
looking at [how TabFS works](#design) -- it's pretty much just two
files! -- and that they can mess around with it; it shouldn't be a
black box.)

Before doing anything, clone [this repository](https://github.com/osnr/TabFS):

```
$ git clone https://github.com/osnr/TabFS.git
```

First, install the browser extension.

Then, install the C filesystem.

### 1. Install the browser extension

#### in Chrome, Chromium, and related browsers

(including Brave and Vivaldi)

Go to the [Chrome extensions page](chrome://extensions). Enable
Developer mode (top-right corner).

Load-unpacked the `extension/` folder in this repo.

**Make a note of the extension ID Chrome assigns.** Mine is
`jimpolemfaeckpjijgapgkmolankohgj`. We'll use this later.

#### in Firefox

You'll need to install as a "temporary extension", so it'll only last
in your current FF session. (If you want to install permanently, see
[this
issue](https://github.com/osnr/TabFS/issues/4#issuecomment-753447380).)

Go to [about:debugging#/runtime/this-firefox](about:debugging#/runtime/this-firefox).

Load Temporary Add-on...

Choose manifest.json in the extension subfolder of this repo.

### 2. Install the C filesystem

First, make sure you have FUSE and FUSE headers. On Linux, for example,
`sudo apt install libfuse-dev` or equivalent. On macOS, get
[macFUSE](https://osxfuse.github.io/). (on macOS, also see [this
-bug](https://github.com/osnr/TabFS/issues/11) -- TODO work out the
best path to explain here)

Then compile the C filesystem:

```
$ cd fs
$ mkdir mnt
$ make
```

(GNU Make is required, so use gmake on FreeBSD)

Now install the native messaging host into your browser, so the
extension can launch and talk to the filesystem:

#### Chrome, Chromium, and related browsers

Substitute the extension ID you copied earlier for
`jimpolemfaeckpjijgapgkmolankohgj` in the command below.

```
$ ./install.sh chrome jimpolemfaeckpjijgapgkmolankohgj
```

(For Chromium, say `chromium` instead of `chrome`. For Vivaldi, say
`vivaldi` instead. For Brave, say `chrome`. You can look at the
contents of
[install.sh](https://github.com/osnr/TabFS/blob/master/install.sh) for
the latest on browser and OS support.)

#### Firefox

```
$ ./install.sh firefox
```

### 3. Ready!

Go back to `chrome://extensions` or
`about:debugging#/runtime/this-firefox` and reload the extension.

Now your browser tabs should be mounted in `fs/mnt`!

Open the background page inspector to see the filesystem operations
stream in. (in Chrome, click "background page" next to "Inspect views"
in the extension's entry in the Chrome extensions page; in Firefox,
click "Inspect")

<div class="figure">
<a href="doc/inspector.png"><img style="max-width: 90%; max-height: 1000px" src="doc/inspector.png"></a>
</div>

This console is also incredibly helpful for debugging anything that
goes wrong, which probably will happen. (If you get a generic I/O
error at the shell when running a command on TabFS, that probably
means that an exception happened which you can check here.)

(My OS and applications are pretty chatty. They do a lot of
operations, even when I don't feel like I'm actually doing
anything. My sense is that macOS is generally chattier than Linux.)

## Design

- `fs/`: Native FUSE filesystem, written in C
  - [`tabfs.c`](https://github.com/osnr/TabFS/tree/master/fs/tabfs.c):
    Talks to FUSE, implements fs operations, talks to extension. I
    rarely have to change this file; it essentially is just a stub
    that forwards everything to the browser extension.
- `extension/`: Browser extension, written in JS
  - [`background.js`](https://github.com/osnr/TabFS/tree/master/extension/background.js):
    **The most interesting file**. Defines all the synthetic files and
    what browser operations they invoke behind the scenes.[^frustrates]

[^frustrates]: it frustrates me that I can't show you, like, a table
    of contents for this source file. because it does have a structure
    to it! so I feel like the UI for looking at this one file should
    be
    [custom-tailored](https://twitter.com/rsnous/status/1262956983222591488)
    to
    [highlight](https://twitter.com/rsnous/status/1262957486262214657)
    and exploit that structure. (I wonder what other cases like this
    are out there, where ad hoc UI for one file would be useful. like
    if you have tangled-but-regular business logic, or the giant
    opcode switch statement of an emulator or interpreter.)
    
    I want to link you to a particular route and talk about it here
    and also have some kind of
    transclusion (without the horrifying mess of making a lot of tiny
    separate files). I want to use typesetting and whitespace to set
    each route in that file apart, and set them as a whole apart from the utility functions &
    default implementations & networking.

My understanding is that when you, for example, `cat
mnt/tabs/by-id/6377/title.txt` in the tab filesystem:

1. `cat` on your computer does a system call `open()` down into macOS
   or Linux,

2. macOS/Linux sees that this path is part of a FUSE filesystem, so it
   forwards the `open()` to the FUSE kernel module,

3. FUSE forwards it to the `tabfs_open` implementation in our
   userspace filesystem in `fs/tabfs.c`,

4. then `tabfs_open` rephrases the request as a JSON string and
   forwards it to our browser extension over stdout (['native
   messaging'](https://developer.chrome.com/docs/apps/nativeMessaging/)),

6. our browser extension in `extension/background.js` gets the
   incoming message; it triggers the route for
   `/tabs/by-id/*/title.txt`, which calls the browser extension API
   `browser.tabs.get` to get the data about tab ID `6377`, including
   its title,

7. so when `cat` does `read()` later, the title can get sent back in
   a JSON native message to `tabfs.c` and finally back to FUSE and the
   kernel and `cat`.

(very little actual work happened here, tbh. it's all just
marshalling)

TODO: make diagrams?

## License

GPLv3

## Sponsors

Thanks to [all the project sponsors](https://github.com/sponsors/osnr). Special
thanks to:

<a href="https://oss.capital/"><img style="max-width: 50%" src="oss-capital.png"></a>

## things that could/should be done

(maybe you can do these? lots of people are [already pitching in on
GitHub](https://github.com/osnr/TabFS); I wish it was easier for me to
keep up listing them all here!)

- [add more synthetic files!! (it's just
  JavaScript)](https://twitter.com/rsnous/status/1345113873792126976)
  view DOM nodes, snapshot current HTML of page, spelunk into living
  objects. see what your code is doing. make more files writable also

- build more (GUI and CLI) tools on top, on both sides

- more persistence stuff. as I said earlier, it would also be cool if
  you could put arbitrary files in the subtrees, so .git, Mac extended
  attrs, editor temp files, etc all work. make it able to behave like
  a 'real' filesystem. also as I said earlier, some weirdness in the
  fact that tabs are so disposable; they have a very different
  lifecycle from most parts of my real filesystem. how to nudge that?

- why can't Preview open images? GUI programs often struggle with the
  filesystem for some reason. CLI more reliable

- ~~multithreading. the key constraint is that I pass `-s` to
  `fuse_main` in `tabfs.c`, which makes everything
  single-threaded. but I'm not clear on how much it would improve
  performance? maybe a lot, but not sure. maybe workload-dependent?~~

    ~~the extension itself (and the stdin/stdout comm between the fs
  and the extension) would still be single-threaded, but you could
  interleave requests since most of that stuff is async. like the
  screenshot request that takes like half a second, you could do other
  stuff while waiting for the browser to get back to you on that (?)~~
  *update: [we are
  multithreaded](https://github.com/osnr/TabFS/pull/29) now, thanks to
  [huglovefan](https://github.com/huglovefan)!*

    another issue is that _applications_ tend to hang if any
  individual request hangs anyway; they're not expecting the
  filesystem to be so slow (and to be fair to them, they really have
  [no way](https://twitter.com/whitequark/status/1133905587819941888)
  to). some of these problems may be inevitable for any FUSE
  filesystem, even ones you'd assume are reasonably battle-tested and
  well-engineered like sshfs?

- other performance stuff -- remembering when we're already attached
  to things, reference counting, minimizing browser roundtrips. not
  sure impact of these

- TypeScript (how to do with the minimum amount of build system and
  package manager nonsense?) (now realizing that if I had gone with
  TypeScript, I would then have to ask people to install npm and
  webpack and the TS compiler and whatever just to get this
  running. really, really glad I didn't.) maybe we can just do dynamic
  type checking at the fs op call boundaries?

- [look into support for Firefox / Windows / Safari /
  etc.](https://github.com/osnr/TabFS/issues?q=is%3Aopen+is%3Aissue+label%3Aport)
  best FUSE equiv for Windows? can you bridge to the remote debugging
  APIs that all of them already have to get the augmented
  functionality? or just implement it all with JS monkey patching?

- window management. tab management where you can move tabs. 'merge
  all windows'. [history management](https://anildash.com/2021/01/03/keeping-tabs-on-your-abstractions/)

## hmm

- [Processes as Files
(1984)](https://lucasvr.gobolinux.org/etc/Killian84-Procfs-USENIX.pdf),
[Julia Evans /proc comic](https://drawings.jvns.ca/proc/) lay out the
original `/proc` filesystem. it's very cool!  very elegant in how it
reapplies the existing interface of files to the new domain of Unix
processes. but how much do I care about Unix processes now? most
[programs](https://twitter.com/rsnous/status/1176587656915849218) that
I care about running on my computer these days are Web pages, [not
Unix
processes](https://twitter.com/rsnous/status/1076229968017772544). so
I want to take the approach of `/proc` -- 'expose the stuff you care
about as a filesystem' -- and apply it to something
[modern](https://twitter.com/rsnous/status/1251342095698112512): the
inside of the browser. 'browser tabs as files'

- there are two 'operating systems' on my computer, the browser and
Unix, and Unix is by far the more accessible and programmable and
cohesive as a computing environment (it has concepts that compose!
shell, processes, files), even though it's arguably the less important
to my daily life. [how can the browser take on more of the properties
of Unix?](https://twitter.com/jcreed/status/1344982366243213312)

- it's [way too
hard](https://twitter.com/rsnous/status/1342236988938719232) to make a
browser extension. even 'make an extension' is a bad framing; it
suggests making an extension is a whole Thing, a whole Project. like,
why can't I just take a minute to ask my browser a question or tell it
to automate something? lightness

- "files are a sort of approachable 'bridge' that everyone knows how
  to interact with" / files are like one of the first things you learn
  if you know any programming language / ["because of this fs thing any
  beginner coding thing can make use of it now"](https://twitter.com/rsnous/status/1345490658836926464)

- a lot of existing uses of these browser control APIs are in an
  automation context: testing your code on a robotic browser as part
  of some pipeline. I'm much more interested in an interactive,
  end-user context. augmenting the way I use my everyday
  browser. that's why this is an extension. it doesn't require your
  browser to run in some weird remote debugging mode that you'd always
  forget to turn on. it just [stays
  running](https://twitter.com/rsnous/status/1340150818553561094)

- [system call tracing](https://jvns.ca/strace-zine-v2.pdf) (dtruss or
  strace) super useful when anything is going wrong. (need to disable
  SIP on macOS, though.)  the combination of dtruss (application side)
  & console logging fs request/response (filesystem side) gives a huge
  amount of insight into basically any problem, end to end

    - there is sort of this sequence that I learned to try with
      anything. first, either simple shell commands or pure C calls --
      shell commands are more ergonomic, C calls have the clearest
      mental model of what syscalls they actually invoke. only then do
      you move to the text editor or the Mac Finder, which are a lot
      fancier and throw a lot more stuff at the filesystem at once (so
      more can go wrong)

- for a lot of things in the extension API, the browser can notify you
  of updates but there's no apparent way to query the full current
  state. so we'd need to sit in a lot of these places from the
  beginning and accumulate the incoming events to know, like, the last
  time a tab was updated, or the list of scripts currently running on
  a tab

- async/await was absolutely vital to making this readable

- filesystem as 'open input space' where there are things you can say
  beyond what this particular filesystem cares about. (it reminds me
  of my [Screenotate](https://screenotate.com) -- screenshots give you
  this open field where you can [carry
  through](https://twitter.com/rsnous/status/1221687986510680064)
  stuff that the OCR doesn't necessarily recognize or care about. same
  for the real world in Dynamicland; you can scribble notes or
  whatever even if the computer doesn't see them)

- now you have this whole 'language', this whole toolset, to control
and automate your browser. there's this built-up existing capital
where lots of people and lots of application software and lots of
programming languages ... already know the operations to work with
files

- this project is cool bc i immediately get [a dataset i care
  about](https://twitter.com/rsnous/status/1084166291793965056). I
  found myself using it 'authentically' pretty quickly -- to clear out
  my tabs, to help me develop other things in the browser so I'd have
  actions I could trigger from my editor, ...

- stuff that looks cool / is related:

    - [SQLite virtual tables](https://www.sqlite.org/vtablist.html)
      have some of the same energy as FUSE synthetic filesystems to
      me, except instead of 'file operations', 'SQL' is the well-known
      interface / knowledge base / ecosystem that they
      [piggyback](https://twitter.com/rsnous/status/1237986368812224513)
      on. [osquery](https://osquery.readthedocs.io/en/stable/) seems
      particularly cool

    - Plan 9. I think a lot about [extensibility in the Acme text
      editor](https://mostlymaths.net/2013/03/extensibility-programming-acme-text-editor.html/),
      where
      [instead](https://twitter.com/geoffreylitt/status/1265384495542415360)
      of a 'plugin API', the editor just provides a synthetic
      filesystem

    - my [fake filesystems talk](https://www.youtube.com/watch?v=pfHpDDXJQVg)

    - [Witchcraft](https://luciopaiva.com/witchcraft/) has the right
      idea for how to set up userscripts. just make files -- don't
      make [your own weird UI to add and remove
      them](https://twitter.com/rsnous/status/1196536798312140800). (I
      guess there is a political or audience
      [tradeoff](https://twitter.com/rsnous/status/1290031845363466242)
      here, where [some
      kinds](https://twitter.com/rsnous/status/1039036578427891713) of
      users might be comfortable with managing files, but you might
      alienate others. hmm)

- [rmdir a non-empty
  directory](https://twitter.com/rsnous/status/1107427906832089088)
  -- when I was thinking if you should be able to `rm by-id/TABID`
  even though `TABID` is a folder. I feel like a new OS, something
  like Plan 9, should
  [generalize](https://twitter.com/rsnous/status/1070830656005988352)
  its file I/O APIs just enough to avoid problems like this. like
  design them with the disk in mind but also a few concrete cases of
  synthetic filesystems, very slow remote filesystems, etc

do you like setting up sockets? I don't

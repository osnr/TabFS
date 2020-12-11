const TESTING = (typeof chrome === 'undefined');

const unix = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  ENOTSUP: 45,

  // Unix file types
  S_IFMT: 0170000, // type of file mask
  S_IFIFO: 010000, // named pipe (fifo)
  S_IFCHR: 020000, // character special
  S_IFDIR: 040000, // directory
  S_IFBLK: 060000, // block special
  S_IFREG: 0100000, // regular
  S_IFLNK: 0120000, // symbolic link
  S_IFSOCK: 0140000, // socket
}

class UnixError extends Error {
  constructor(error) { super(); this.name = "UnixError"; this.error = error; }
}

// tabs/by-id/ID/title
// tabs/by-id/ID/url
// tabs/by-id/ID/console
// tabs/by-id/ID/mem (?)
// tabs/by-id/ID/cpu (?)
// tabs/by-id/ID/screenshot.png
// tabs/by-id/ID/text.txt
// tabs/by-id/ID/printed.pdf
// tabs/by-id/ID/control
// tabs/by-id/ID/sources/

function pathComponent(path, i) {
  const components = path.split('/');
  return components[i >= 0 ? i : components.length + i];
}
function sanitize(s) { return s.replace(/[^A-Za-z0-9_\-\.]/gm, '_'); }
function utf8(str, offset, size) {
  // converts to UTF8, then takes slice
  var utf8 = [];
  for (var i=0; i < str.length; i++) {
    var charcode = str.charCodeAt(i);
    if (charcode < 0x80) utf8.push(charcode);
    else if (charcode < 0x800) {
      utf8.push(0xc0 | (charcode >> 6), 
                0x80 | (charcode & 0x3f));
    }
    else if (charcode < 0xd800 || charcode >= 0xe000) {
      utf8.push(0xe0 | (charcode >> 12), 
                0x80 | ((charcode>>6) & 0x3f), 
                0x80 | (charcode & 0x3f));
    }
    // surrogate pair
    else {
      i++;
      charcode = ((charcode&0x3ff)<<10)|(str.charCodeAt(i)&0x3ff)
      utf8.push(0xf0 | (charcode >>18), 
                0x80 | ((charcode>>12) & 0x3f), 
                0x80 | ((charcode>>6) & 0x3f), 
                0x80 | (charcode & 0x3f));
    }
  }
  return String.fromCharCode(...utf8.slice(offset, offset + size))
}
function stringSize(str) {
  // returns the byte length of an utf8 string
  var s = str.length;
  for (var i=str.length-1; i>=0; i--) {
    var code = str.charCodeAt(i);
    if (code > 0x7f && code <= 0x7ff) s++;
    else if (code > 0x7ff && code <= 0xffff) s+=2;
    if (code >= 0xDC00 && code <= 0xDFFF) i--; //trail surrogate
  }
  return s + 1;
}

const TabManager = {
  tabState: {},

  debugTab: async function(tabId) {
    this.tabState[tabId] = this.tabState[tabId] || {};
    if (this.tabState[tabId].debugging) {
      this.tabState[tabId].debugging += 1;

    } else {
      await new Promise((resolve, reject) => chrome.debugger.attach({tabId}, "1.3", async () => {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message.indexOf('Another debugger is already attached') !== -1) {
            chrome.debugger.detach({tabId}, () => {this.debugTab(tabId)});
          } else {
            reject(chrome.runtime.lastError); return;
          }
          return;
        }
        this.tabState[tabId].debugging = 1; resolve();
      }));
    }
  },
  enableDomainForTab: async function(tabId, domain) {
    this.tabState[tabId] = this.tabState[tabId] || {};
    if (this.tabState[tabId][domain]) { this.tabState[tabId][domain] += 1;
    } else {
      await sendDebuggerCommand(tabId, `${domain}.enable`, {});
      this.tabState[tabId][domain] = 1;
    }
  }
};

function sendDebuggerCommand(tabId, method, commandParams) {
  return new Promise((resolve, reject) =>
    chrome.debugger.sendCommand({tabId}, method, commandParams, result => {
      if (result) { resolve(result); } else { reject(chrome.runtime.lastError); }
    })
  );
}

const BrowserState = { lastFocusedWindowId: null };
(function() {
  browser.windows.getLastFocused().then(window => { BrowserState.lastFocusedWindowId = window.id; });
  browser.windows.onFocusChanged.addListener(windowId => {
    if (windowId !== -1) BrowserState.lastFocusedWindowId = windowId;
  });
})();

/* if I could specify a custom editor interface for all the routing
   below ... I would highlight the route names in blocks of some color
   that sticks out, and let you collapse them. then you could get a
   view of what the whole filesystem looks like at a glance. */
const router = {};

function withTab(handler) {
  return {
    async getattr({path}) {
      const tab = await browser.tabs.get(parseInt(pathComponent(path, -2)));
      return {
        st_mode: unix.S_IFREG | 0444,
        st_nlink: 1,
        st_size: stringSize(handler(tab))
      };
    },
    async open({path}) { return { fh: 0 }; },
    async read({path, fh, size, offset}) {
      const tab = await browser.tabs.get(parseInt(pathComponent(path, -2)));
      return { buf: utf8(handler(tab), offset, size) };
    }
  };
}
function fromScript(code) {
  return {
    async getattr({path}) {
      const tabId = parseInt(pathComponent(path, -2));
      return {
        st_mode: unix.S_IFREG | 0444,
        st_nlink: 1,
        st_size: stringSize((await browser.tabs.executeScript(tabId, {code}))[0])
      };
    },
    async open({path}) { return { fh: 0 }; },
    async read({path, fh, size, offset}) {
      const tabId = parseInt(pathComponent(path, -2));
      return { buf: utf8((await browser.tabs.executeScript(tabId, {code}))[0], offset, size) }
    }
  };
}
const Cache = {
  // used when you open a file to cache the content we got from the browser
  // until you close that file.
  store: {}, nextHandle: 0,
  storeObject(object) {
    const handle = ++this.nextHandle;
    this.store[handle] = object;
    return handle;
  },
  getObjectForHandle(handle) { return this.store[handle]; },
  removeObjectForHandle(handle) { delete this.store[handle]; }
};

router["/tabs/by-id"] = {  
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: tabs.map(tab => String(tab.id)) };
  }
};
router["/tabs/by-id/*/url"] = withTab(tab => tab.url + "\n");
router["/tabs/by-id/*/title"] = withTab(tab => tab.title + "\n");
router["/tabs/by-id/*/text"] = fromScript(`document.body.innerText`);
router["/tabs/by-id/*/screenshot.png"] = {
  async open({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
    // FIXME: cache.

    const {data} = await sendDebuggerCommand(tabId, "Page.captureScreenshot");
    return { fh: Cache.storeObject(Uint8Array.from(atob(data), c => c.charCodeAt(0))) };
  },
  async read({path, fh, size, offset}) {
    const slice = Cache.getObjectForHandle(fh).slice(offset, offset + size);
    return { buf: String.fromCharCode(...slice) };
  },
  async close({fh}) { Cache.removeObjectForHandle(fh); }
};
router["/tabs/by-id/*/resources"] = {
  async opendir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    await TabManager.debugTab(tabId);
    return { fh: 0 };
  },
  async readdir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    return { entries: frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200))) };
  }
};
router["/tabs/by-id/*/resources/*"] = {
  async getattr({path}) {
    // FIXME: cache the file
    const tabId = parseInt(pathComponent(path, -3));
    const suffix = pathComponent(path, -1);

    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url).slice(0, 200));
      if (resourceSuffix === suffix) {
        let {base64Encoded, content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
          frameId: frameTree.frame.id,
          url: resource.url
        });
        if (base64Encoded) {
          content = atob(content);
        }
        return {
          st_mode: unix.S_IFREG | 0444,
          st_nlink: 1,
          st_size: stringSize(content) // FIXME
        };
      }
    }
  },
  async open({path}) {
    // FIXME: cache the file.
    const tabId = parseInt(pathComponent(path, -3));
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
    return {fh: 3};
  },
  async read({path, fh, size, offset}) {
    const tabId = parseInt(pathComponent(path, -3));
    const suffix = pathComponent(path, -1);

    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {}); // FIXME: cache this
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url).slice(0, 200));
      if (resourceSuffix === suffix) {
        let {base64Encoded, content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
          frameId: frameTree.frame.id,
          url: resource.url
        });
        if (base64Encoded) {
          const arr = Uint8Array.from(atob(content), c => c.charCodeAt(0));
          const slice = arr.slice(offset, offset + size);
          return { buf: String.fromCharCode(...slice) };
        } else {
          return { buf: utf8(content, offset, size) };
        }
      }
    }
    throw new UnixError(unix.ENOENT);
  },
  async release({path, fh}) {
    // FIXME: free the debug?
    return {};
  }
};

router["/tabs/by-id/*/control"] = {
  // echo remove >> mnt/tabs/by-id/1644/control
  async write({path, buf}) {
    const tabId = parseInt(pathComponent(path, -2));
    const command = buf.trim();
    // can use `discard`, `remove`, `reload`, `goForward`, `goBack`...
    // see https://developer.chrome.com/extensions/tabs
    await new Promise(resolve => chrome.tabs[command](tabId, resolve));
  }
};

router["/tabs/by-title"] = {
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: tabs.map(tab => sanitize(String(tab.title).slice(0, 200)) + "_" + String(tab.id)) };
  }
};
router["/tabs/by-title/*"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async readlink({path}) {
    const parts = path.split("_");
    const id = parts[parts.length - 1];
    return { buf: "../by-id/" + id };
  }
};

router["/tabs/last-focused"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async readlink({path}) {
    const id = (await browser.tabs.query({ active: true, windowId: BrowserState.lastFocusedWindowId }))[0].id;
    return { buf: "by-id/" + id };
  }
}

// Ensure that there are routes for all ancestors. This algorithm is
// probably not correct, but whatever.  I also think it would be
// better to compute this stuff on the fly, so you could patch more
// routes in at runtime, but I need to think a bit about how to make
// that work with wildcards.
for (let key in router) {
  let path = key;
  while (path !== "/") { // walk upward through the path
    path = path.substr(0, path.lastIndexOf("/"));
    if (path == '') path = '/';

    if (!router[path]) {
      // find all direct children
      let children = Object.keys(router)
                           .filter(k => k.startsWith(path) &&
                                      (k.match(/\//g) || []).length ===
                                        (path.match(/\//g) || []).length + 1)
                           .map(k => k.substr((path === '/' ? 0 : path.length) + 1).split('/')[0]);
      children = [...new Set(children)];

      router[path] = { readdir() { return { entries: children }; } };
    }
  }
}
if (TESTING) { // I wish I could color this section with... a pink background, or something.
  const assert = require('assert');
  (async () => {
    assert.deepEqual(await router['/tabs/by-id/*'].readdir(), ['url', 'title', 'text', 'control']);
    assert.deepEqual(await router['/'].readdir(), ['tabs']);
    assert.deepEqual(await router['/tabs'].readdir(), ['by-id', 'by-title']);
    
    assert.deepEqual(findRoute('/tabs/by-id/TABID/url'), router['/tabs/by-id/*/url']);
  })()
}


// fill in default implementations of fs ops
for (let key in router) {
  // if readdir -> directory -> add getattr, opendir, releasedir
  if (router[key].readdir) {
    router[key] = {
      getattr() { 
        return {
          st_mode: unix.S_IFDIR | 0755,
          st_nlink: 3,
          st_size: 0,
        };
      },
      opendir({path}) { return { fh: 0 }; },
      releasedir({path}) { return {}; },
      ...router[key]
    };

  } else if (router[key].readlink) {
    router[key] = {
      async getattr({path}) {
        const st_size = (await this.readlink({path})).length + 1;
        return {
          st_mode: unix.S_IFLNK | 0444,
          st_nlink: 1,
          // You _must_ return correct linkee path length from getattr!
          st_size
        };
      },
      ...router[key]
    };
    
  } else if (router[key].read || router[key].write) {
    router[key] = {
      async getattr() {
        return {
          st_mode: unix.S_IFREG | ((router[key].read && 0444) || (router[key].write && 0222)),
          st_nlink: 1,
          st_size: 100 // FIXME
        };
      },
      open() {
        return { fh: 0 };
      },
      release() {
        return {};
      },
      ...router[key]
    };
  }
}

console.log(router);
function findRoute(path) {
  let pathSegments = path.split("/");
  
  if (pathSegments[pathSegments.length - 1].startsWith("._")) {
    throw new UnixError(unix.ENOTSUP); // Apple Double file for xattrs
  }

  let routingPath = "";
  for (let segment of pathSegments) {
    if (routingPath === "/") { routingPath = ""; }

    if (router[routingPath + "/*"]) {
      routingPath += "/*";
    } else if (router[routingPath + "/" + segment]) {
      routingPath += "/" + segment;
    } else {
      throw new UnixError(unix.ENOENT);
    }
  }
  return router[routingPath];
}

let port;
async function onMessage(req) {
  if (req.buf) req.buf = atob(req.buf);
  /* console.log('req', req);*/

  let response = { op: req.op, error: unix.EIO };
  /* console.time(req.op + ':' + req.path);*/
  try {
    response = await findRoute(req.path)[req.op](req);
    response.op = req.op;
    if (response.buf) { response.buf = btoa(response.buf); }

  } catch (e) {
    console.error(e);
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    }
  }
  /* console.timeEnd(req.op + ':' + req.path);*/

  /* console.log('resp', response);*/
  port.postMessage(response);
};

function tryConnect() {
  port = chrome.runtime.connectNative('com.rsnous.tabfs');
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {console.log('disconnect', p)});
}

if (!TESTING) {
  tryConnect();
}

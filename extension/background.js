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

function pathComponent(path, i) {
  const components = path.split('/');
  return components[i >= 0 ? i : components.length + i];
}
function sanitize(s) { return s.replace(/[^A-Za-z0-9_\-\.]/gm, '_'); }
function utf8(str) {
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
  return utf8;
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
            chrome.debugger.detach({tabId}, async () => {
              await TabManager.debugTab(tabId);
              resolve();
            });
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

const BrowserState = { lastFocusedWindowId: null, scriptsForTab: {} };
(function() {
  browser.windows.getLastFocused().then(window => { BrowserState.lastFocusedWindowId = window.id; });
  browser.windows.onFocusChanged.addListener(windowId => {
    if (windowId !== -1) BrowserState.lastFocusedWindowId = windowId;
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    console.log(source, method, params);
    if (method === "Debugger.scriptParsed") {
      BrowserState.scriptsForTab[source.tabId] = BrowserState.scriptsForTab[source.tabId] || [];
      BrowserState.scriptsForTab[source.tabId].push(params);
    }
  });
})();

const router = {};

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
function toArray(stringOrArray) {
  if (typeof stringOrArray == 'string') { return utf8(stringOrArray); }
  else { return stringOrArray; }
}
const fromStringMaker = stringMaker => ({
  async getattr({path}) {
    return {
      st_mode: unix.S_IFREG | 0444,
      st_nlink: 1,
      st_size: toArray(await stringMaker(path)).length
    };
  },
  async open({path}) { return { fh: Cache.storeObject(toArray(await stringMaker(path))) }; },
  async read({path, fh, size, offset}) {
    return { buf: String.fromCharCode(...Cache.getObjectForHandle(fh).slice(offset, offset + size)) }
  },
  async release({fh}) { Cache.removeObjectForHandle(fh); return {}; }
});

router["/tabs/by-id"] = {  
  async readdir() {
    const tabs = await browser.tabs.query({});
    return { entries: tabs.map(tab => String(tab.id)) };
  }
};
// (should these have .txt extensions?)
// title
// url
// text
// TODO: document.html

// TODO: console
// TODO: mem (?)
// TODO: cpu (?)

// screenshot.png (TODO: when unfocused?)
// TODO: archive.mhtml ?
// TODO: printed.pdf
// control
// resources/
// TODO: scripts/

(function() {
  const withTab = handler => fromStringMaker(async path => {
    const tabId = parseInt(pathComponent(path, -2));
    const tab = await browser.tabs.get(tabId);
    return handler(tab);
  });
  const fromScript = code => fromStringMaker(async path => {
    const tabId = parseInt(pathComponent(path, -2));
    return (await browser.tabs.executeScript(tabId, {code}))[0];
  });

  router["/tabs/by-id/*/url"] = withTab(tab => tab.url + "\n");
  router["/tabs/by-id/*/title"] = withTab(tab => tab.title + "\n");
  router["/tabs/by-id/*/text"] = fromScript(`document.body.innerText`);
})();
router["/tabs/by-id/*/screenshot.png"] = fromStringMaker(async path => {
  const tabId = parseInt(pathComponent(path, -2));
  await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

  const {data} = await sendDebuggerCommand(tabId, "Page.captureScreenshot");
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
});
router["/tabs/by-id/*/resources"] = {
  async readdir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");
    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    return { entries: frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200))) };
  }
};
router["/tabs/by-id/*/resources/*"] = fromStringMaker(async path => {
  const [tabId, suffix] = [parseInt(pathComponent(path, -3)), pathComponent(path, -1)];

  await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Page");

  const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
  for (let resource of frameTree.resources) {
    const resourceSuffix = sanitize(String(resource.url).slice(0, 200));
    if (resourceSuffix === suffix) {
      let {base64Encoded, content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
        frameId: frameTree.frame.id,
        url: resource.url
      });
      if (base64Encoded) { return Uint8Array.from(atob(content), c => c.charCodeAt(0)); }
      return content;
    }
  }
  throw new UnixError(unix.ENOENT);
});
router["/tabs/by-id/*/scripts"] = {
  async opendir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    await TabManager.debugTab(tabId); await TabManager.enableDomainForTab(tabId, "Debugger");
    return { fh: 0 };
  },
  async readdir({path}) {
    const tabId = parseInt(pathComponent(path, -2));
    return { entries: BrowserState.scriptsForTab[tabId].map(params => sanitize(params.url).slice(0, 200)) };
    /* const {frameTree} = await sendDebuggerCommand(tabId, "Debugger.scriptParsed", {});
     * return { entries: frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200))) };*/
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
  console.log('req', req);

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

  console.log('resp', response);
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

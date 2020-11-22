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

function UnixError(error) {
  this.name = "UnixError";
  this.error = error;
}
UnixError.prototype = Error.prototype;

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
function sanitize(s) {
  return s.replace(/[^A-Za-z0-9_\-\.]/gm, '_');
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

const debugging = {};
async function debugTab(tabId) {
  if (!debugging[tabId]) {
    await new Promise(resolve => chrome.debugger.attach({tabId}, "1.3", resolve));
    debugging[tabId] = 0;
  }
  debugging[tabId] += 1;
}
function sendDebuggerCommand(tabId, method, commandParams) {
  return new Promise((resolve, reject) =>
    chrome.debugger.sendCommand({tabId}, method, commandParams, result => {
      console.log(method, result);
      if (result) {
        resolve(result);
      } else {
        reject(chrome.runtime.lastError);
      }
    })
  );
}

let lastFocusedWindowId;
browser.windows.getLastFocused().then(window => { lastFocusedWindowId = window.id; });
browser.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== -1) lastFocusedWindowId = windowId;
});

/* if I could specify a custom editor interface for all the routing
   below ... I would highlight the route names in blocks of some color
   that sticks out, and let you collapse them. then you could get a
   view of what the whole filesystem looks like at a glance. */
const router = {};

function withTab(handler) {
  return {
    async getattr(path) {
      const tab = await browser.tabs.get(parseInt(pathComponent(path, -2)));
      return {
        st_mode: unix.S_IFREG | 0444,
        st_nlink: 1,
        st_size: stringSize(handler(tab))
      };
    },
    async read(path, fh, size, offset) {
      const tab = await browser.tabs.get(parseInt(pathComponent(path, -2)));
      return handler(tab).substr(offset, size);
    }
  };
}
function fromScript(code) {
  return {
    async getattr(path) {
      const tabId = parseInt(pathComponent(path, -2));
      return {
        st_mode: unix.S_IFREG | 0444,
        st_nlink: 1,
        st_size: stringSize((await browser.tabs.executeScript(tabId, {code}))[0])
      };
    },
    async read(path, fh, size, offset) {
      const tabId = parseInt(pathComponent(path, -2));
      return (await browser.tabs.executeScript(tabId, {code}))[0]
        .substr(offset, size);
    }
  };
}

router["/tabs/by-id"] = {
  async entries() {
    const tabs = await browser.tabs.query({});
    return tabs.map(tab => String(tab.id));
  }
}
router["/tabs/by-id/*/url"] = withTab(tab => tab.url + "\n");
router["/tabs/by-id/*/title"] = withTab(tab => tab.title + "\n");
router["/tabs/by-id/*/text"] = fromScript(`document.body.innerText`);
router["/tabs/by-id/*/resources"] = {
  async opendir(path) {
    const tabId = parseInt(pathComponent(path, -2));
    await debugTab(tabId);
    return 0;
  },
  async entries(path) {
    const tabId = parseInt(pathComponent(path, -2));
    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    return frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200)));
  }
};
router["/tabs/by-id/*/resources/*"] = {
  async getattr(path) {
    const tabId = parseInt(pathComponent(path, -3));
    const suffix = pathComponent(path, -1);

    if (!debugging[tabId]) throw new UnixError(unix.EIO);

    await sendDebuggerCommand(tabId, "Page.enable", {});

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
  async read(path, fh, size, offset) {
    const tabId = parseInt(pathComponent(path, -3));
    const suffix = pathComponent(path, -1);

    if (!debugging[tabId]) throw new UnixError(unix.EIO);

    await sendDebuggerCommand(tabId, "Page.enable", {});

    const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
    for (let resource of frameTree.resources) {
      const resourceSuffix = sanitize(String(resource.url).slice(0, 200));
      if (resourceSuffix === suffix) {
        let {base64Encoded, content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
          frameId: frameTree.frame.id,
          url: resource.url
        });
        if (base64Encoded) {
          const buf = btoa(atob(content).substr(offset, size));
          return { buf, base64Encoded: true };
        }
        return content.substr(offset, size);
      }
    }
    throw new UnixError(unix.ENOENT);
  },
  async release(path, fh) {
    return {};
  }
};

router["/tabs/by-id/*/control"] = {
  // echo remove >> mnt/tabs/by-id/1644/control
  async write(path, buf) {
    const tabId = parseInt(pathComponent(path, -2));
    const command = buf.trim();
    // can use `discard`, `remove`, `reload`, `goForward`, `goBack`...
    // see https://developer.chrome.com/extensions/tabs
    await new Promise(resolve => chrome.tabs[command](tabId, resolve));
  }
};

router["/tabs/by-title"] = {
  async entries() {
    const tabs = await browser.tabs.query({});
    return tabs.map(tab => sanitize(String(tab.title).slice(0, 200)) + "_" + String(tab.id));
  }
};
router["/tabs/by-title/*"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async getattr(path) {
    const st_size = (await this.readlink(path)).length + 1;
    return {
      st_mode: unix.S_IFLNK | 0444,
      st_nlink: 1,
      // You _must_ return correct linkee path length from getattr!
      st_size
    };
  },
  async readlink(path) {
    const parts = path.split("_");
    const id = parts[parts.length - 1];
    return "../by-id/" + id;
  }
};

router["/tabs/last-focused"] = {
  // a symbolic link to /tabs/by-id/[id for this tab]
  async getattr(path) {
    const st_size = (await this.readlink(path)).length + 1;
    return {
      st_mode: unix.S_IFLNK | 0444,
      st_nlink: 1,
      // You _must_ return correct linkee path length from getattr!
      st_size
    };
  },
  async readlink(path) {
    const id = (await browser.tabs.query({ active: true, windowId: lastFocusedWindowId }))[0].id;
    return "by-id/" + id;
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

      router[path] = {entries() {
        return children;
      }}
    }
  }
}
if (TESTING) { // I wish I could color this section with... a pink background, or something.
  const assert = require('assert');
  (async () => {
    assert.deepEqual(await router['/tabs/by-id/*'].entries(), ['url', 'title', 'text', 'control']);
    assert.deepEqual(await router['/'].entries(), ['tabs']);
    assert.deepEqual(await router['/tabs'].entries(), ['by-id', 'by-title']);
    
    assert.deepEqual(findRoute('/tabs/by-id/TABID/url'), router['/tabs/by-id/*/url']);
  })()
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

const ops = {
  async getattr({path}) {
    let route = findRoute(path);
    if (route.getattr) {
      return {
        st_mode: 0,
        st_nlink: 0,
        st_size: 0,
        ...(await route.getattr(path))
      };
    } else if (route.read || route.write) {
      // default file attrs
      return {
        st_mode: unix.S_IFREG | ((route.read && 0444) || (route.write && 0222)),
        st_nlink: 1,
        st_size: 100 // FIXME
      };
    } else {
      // default dir attrs
      return {
        st_mode: unix.S_IFDIR | 0755,
        st_nlink: 3,
        st_size: 0
      };
    }
  },

  async open({path}) {
    let route = findRoute(path);
    if (route.open) return { fh: await route.open(path) };
    else return { fh: 0 }; // empty fh
  },

  async read({path, fh, size, offset}) {
    let route = findRoute(path);
    if (route.read) {
      const ret = await route.read(path, fh, size, offset);
      if (typeof ret === 'string') {
        return { buf: ret };
      } else {
        return ret;
      }
    }
  },
  async write({path, buf, offset}) {
    let route = findRoute(path);
    if (route.write) return route.write(path, atob(buf), offset);
  },
  async release({path, fh}) {
    let route = findRoute(path);
    if (route.release) return route.release(path, fh);
  },

  async readlink({path}) {
    let route = findRoute(path);
    if (route.readlink) return { buf: await route.readlink(path) };
  },

  async opendir({path}) {
    let route = findRoute(path);
    if (route.opendir) return { fh: await route.opendir(path) };
    else return { fh: 0 }; // empty fh
  },
  async readdir({path}) {
    let route = findRoute(path);
    if (route.entries) return { entries: await route.entries(path) };
  },
  async releasedir({path}) {
    let route = findRoute(path);
    if (route.releasedir) return route.releasedir(path);
    else return {};
  }
};

let port;
async function onMessage(req) {
  console.log('req', req);

  let response = { op: req.op, error: unix.EIO };
  /* console.time(req.op + ':' + req.path);*/
  try {
    response = await ops[req.op](req);
    response.op = req.op;

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

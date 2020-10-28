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

/* if I could specify a custom editor interface for all the routing
   below ... I would highlight the route names in blocks of some color
   that sticks out, and let you collapse them. then you could get a
   view of what the whole filesystem looks like at a glance. */
const router = {};

async function withTab(handler) {
  return {
    async read(path, fh, size, offset) {
      const tab = await browser.tabs.get(parseInt(pathComponent(path, -2)));
      return handler(tab);
    }
  };
}
async function fromScript(code) {
  return {
    async read(path, fh, size, offset) {
      const tabId = parseInt(pathComponent(path, -2));
      return browser.tabs.executeScript(tabId, {code});
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
router["/tabs/by-id/*/control"] = {
  async write(path, buf) {
    const tabId = parseInt(pathComponent(path, -2));
    if (buf.trim() === 'close') {
      await new Promise(resolve => chrome.tabs.remove(tabId, resolve));
    } else {
      throw new UnixError(unix.EIO);
    }
  }
};

router["/tabs/by-title"] = {
  async entries() {
    const tabs = await browser.tabs.query({});
    return tabs.map(tab => sanitize(String(tab.title).slice(0, 200)) + "_" + String(tab.id));
  }
};
router["/tabs/by-title/*"] = {
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

    /* "last-focused": {
     *   // FIXME: symlink to tab by id.
     *   async readlink() {
     *     return "../windows/last-focused/selected-tab"
     *   }
     * },
     */

// ensure that there are entries for all parents
for (let key in router) {
  let path = key;
  while (path !== "/") { // walk upward through the path
    path = path.substr(0, path.lastIndexOf("/"));

    if (!router[path]) {
      // find all direct children
      const children = Object.keys(router)
                             .filter(k => k.startsWith(path) &&
                                        (k.match(/\//g) || []).length ===
                                          (path.match(/\//g) || []).length + 1)
                             .map(k => k.substr(path.length + 1))

      if (path == '') path = '/';
      router[path] = {entries() {
        return children;
      }}
    }
  }
}
if (TESTING) {
  const assert = require('assert');
  (async () => {
    assert.deepEqual(await router['/tabs/by-id/*'].entries(), ['url', 'title', 'text', 'control']);
    assert.deepEqual(await router['/'].entries(), ['tabs']);
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
    if (router[routingPath + "/" + segment]) {
      routingPath += "/" + segment;
    } else {
      routingPath += "/*";
    }

    if (!router[routingPath]) throw new UnixError(unix.ENOENT);
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
    if (route.read) return { buf: await route.read(path, fh, size, offset) };
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
    if (route.readdir) return { entries: await route.readdir(path) };
    return { entries: [".", "..", ...Object.keys(route)] };
  },
  async releasedir({path}) {
    let route = findRoute(path);
    if (route.releasedir) return route.releasedir(path);
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
  /* console.log('hello', port);*/
  /* updateToolbarIcon();*/
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {console.log('disconnect', p)});

  /* ws = new WebSocket("ws://localhost:8888");
   * updateToolbarIcon();
   * ws.onopen = ws.onclose = updateToolbarIcon;
   * ws.onmessage = onmessage;*/
}

function updateToolbarIcon() {
  if (port && port.onMessage) { // OPEN
    chrome.browserAction.setBadgeBackgroundColor({color: 'blue'});
    chrome.browserAction.setBadgeText({text: 'f'});
  } else {
    chrome.browserAction.setBadgeBackgroundColor({color: 'red'});
    chrome.browserAction.setBadgeText({text: '!'});
  }
}

if (!TESTING) {
  tryConnect();
  chrome.browserAction.onClicked.addListener(function() {
    tryConnect();
  });
}

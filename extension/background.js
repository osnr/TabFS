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

function getTab(id) {
  return new Promise((resolve, reject) => chrome.tabs.get(id, resolve));
}
function queryTabs() {
  return new Promise((resolve, reject) => chrome.tabs.query({}, resolve));
}

async function debugTab(tabId) {
  if (!debugged[tabId]) {
    await new Promise(resolve => chrome.debugger.attach({tabId}, "1.3", resolve));
    debugged[tabId] = 0;
  }
  debugged[tabId] += 1;
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

const debugged = {};

const router = {
  "tabs": {
    /* "last-focused": {
     *   // FIXME: symlink to tab by id.
     *   async readlink() {
     *     return "../windows/last-focused/selected-tab"
     *   }
     * },
     */
    "by-title": {
      async readdir() {
        const tabs = await queryTabs();
        return tabs.map(tab => sanitize(String(tab.title).slice(0, 200)) + "_" + String(tab.id));
      },
      "*": {
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
      }
    },
    "by-id": {
      async readdir() {
        const tabs = await queryTabs();
        return tabs.map(tab => String(tab.id));
      },

      "*": {
        "url": {
          async read(path, fh, size, offset) {
            const tab = await getTab(parseInt(pathComponent(path, -2)));
            return (tab.url + "\n").substr(offset, size);
          }
        },
        "title": {
          async read(path, fh, size, offset) {
            const tab = await getTab(parseInt(pathComponent(path, -2)));
            return (tab.title + "\n").substr(offset, size);
          }
        },
        "text": {
          async read(path, fh, size, offset) {
            const tabId = parseInt(pathComponent(path, -2));
            await debugTab(tabId);
            await sendDebuggerCommand(tabId, "Runtime.enable", {});
            const {result} = await sendDebuggerCommand(tabId, "Runtime.evaluate", {expression: "document.body.innerText", returnByValue: true});
            return result.value.substr(offset, size)
          }
        },
        "snapshot.mhtml": {
          async read(path, fh, size, offset) {
            const tabId = parseInt(pathComponent(path, -2));
            await debugTab(tabId);
            await sendDebuggerCommand(tabId, "Page.enable", {});

            const {data} = await sendDebuggerCommand(tabId, "Page.captureSnapshot");
            return data.substr(offset, size)
          }
        },
        "screenshot.png": {
          // Broken. Filesystem hangs (? in JS?) and needs to be killed if you read this.
          async read(path, fh, size, offset) {
            const tabId = parseInt(pathComponent(path, -2));
            await debugTab(tabId);
            await sendDebuggerCommand(tabId, "Page.enable", {});

            const {data} = await sendDebuggerCommand(tabId, "Page.captureScreenshot");
            const buf = btoa(atob(data).substr(offset, size));
            return { buf, base64Encoded: true };
          }
        },
        
        "resources": {
          async opendir(path) {
            const tabId = parseInt(pathComponent(path, -2));
            await debugTab(tabId);
            return 0;
          },
          async readdir(path) {
            const tabId = parseInt(pathComponent(path, -2));
            if (!debugged[tabId]) throw new UnixError(unix.EIO);

            const {frameTree} = await sendDebuggerCommand(tabId, "Page.getResourceTree", {});
            return frameTree.resources.map(r => sanitize(String(r.url).slice(0, 200)));
          },
          async releasedir(path) {
            return 0;
          },

          "*": {
            async read(path, fh, size, offset) {
              const tabId = parseInt(pathComponent(path, -3));
              const suffix = pathComponent(path, -1);

              if (!debugged[tabId]) throw new UnixError(unix.EIO);

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
            }
          }
        },

        "control": {
          async write(path, buf) {
            const tabId = parseInt(pathComponent(path, -2));
            if (buf.trim() === 'close') {
              await new Promise(resolve => chrome.tabs.remove(tabId, resolve));
            } else {
              throw new UnixError(unix.EIO);
            }
          }
        }
      }
    }
  }
};

function findRoute(path) {
  let route = router;
  let pathSegments = path.split("/");
  if (pathSegments[pathSegments.length - 1].startsWith("._")) {
    throw new UnixError(unix.ENOTSUP); // Apple Double file for xattrs
  }
  for (let segment of pathSegments) {
    if (segment === "") continue;
    route = route[segment] || route["*"];

    if (!route) throw new UnixError(unix.ENOENT);
  }
  return route;
}

async function getattr(path) {
  let route = findRoute(path);
  if (route.getattr) {
    return route.getattr(path);
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
      st_nlink: 3
    };
  }
}

async function open(path) {
  let route = findRoute(path);
  if (route.open) return route.open(path);
  else return 0; // empty fh
}

async function read(path, fh, size, offset) {
  let route = findRoute(path);
  if (route.read) return route.read(path, fh, size, offset);
}
async function write(path, buf, offset) {
  let route = findRoute(path);
  if (route.write) return route.write(path, buf, offset);
}
async function release(path, fh) {
  let route = findRoute(path);
  if (route.release) return route.release(path, fh);
}

async function readlink(path) {
  let route = findRoute(path);
  if (route.readlink) return route.readlink(path);
}

async function opendir(path) {
  let route = findRoute(path);
  if (route.opendir) return route.opendir(path);
  else return 0; // empty fh
}
async function readdir(path) {
  let route = findRoute(path);
  if (route.readdir) return route.readdir(path);
  return Object.keys(route);
}
async function releasedir(path) {
  let route = findRoute(path);
  if (route.releasedir) return route.releasedir(path);
}

function log(...ss) {
  console.log(...ss);
}

let port;
/* let ws;*/
async function onMessage(req) {
  log('req', req);

  let response = { op: req.op, error: unix.EIO };
  /* console.time(req.op + ':' + req.path);*/
  try {
    if (req.op === 'getattr') {
      response = {
        op: 'getattr',
        st_mode: 0,
        st_nlink: 0,
        st_size: 0,
        ...(await getattr(req.path))
      };
    } else if (req.op === 'open') {
      response = {
        op: 'open',
        fh: await open(req.path)
      };

    } else if (req.op === 'read') {
      const ret = await read(req.path, req.fh, req.size, req.offset)
      const buf = typeof ret === 'string' ? ret : ret.buf;
      response = {
        op: 'read',
        buf
      };
      if (ret.base64Encoded) response.base64Encoded = ret.base64Encoded;

    } else if (req.op === 'write') {
      // FIXME: decide whether base64 should be handled here
      // or in a higher layer?
      const ret = await write(req.path, atob(req.buf), req.offset)
      response = {
        op: 'write'
      };

    } else if (req.op === 'release') {
      await release(req.path, req.fh);
      response = {
        op: 'release'
      };

    } else if (req.op === 'readlink') {
      const buf = await readlink(req.path)
      response = {
        op: 'readlink',
        buf
      };

    } else if (req.op === 'opendir') {
      response = {
        op: 'opendir',
        fh: await opendir(req.path)
      };

    } else if (req.op === 'readdir') {
      response = {
        op: 'readdir',
        entries: [".", "..", ...(await readdir(req.path))]
      };

    } else if (req.op === 'releasedir') {
      await releasedir(req.path, req.fh);
      response = { op: 'releasedir' };
    }
  } catch (e) {
    console.error(e);
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    }
  }
  /* console.timeEnd(req.op + ':' + req.path);*/

  log('resp', response);
  /* ws.send(JSON.stringify(response));*/
};

function tryConnect() {
  port = chrome.runtime.connectNative('com.rsnous.TabFS');
  /* console.log('hello', port);*/
  /* updateToolbarIcon();*/
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(p => {log('disconnect', p)});

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

tryConnect();
chrome.browserAction.onClicked.addListener(function() {
  tryConnect();
});

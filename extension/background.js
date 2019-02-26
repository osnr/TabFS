const unix = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,

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
        "tree": {
          async opendir(path) {
            const tabId = parseInt(pathComponent(path, -2));
            if (!debugged[tabId]) {
              await new Promise(resolve => chrome.debugger.attach({tabId}, "1.3", resolve));
              debugged[tabId] = 0;
            }
            debugged[tabId] += 1;
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
                  const {content} = await sendDebuggerCommand(tabId, "Page.getResourceContent", {
                    frameId: frameTree.frame.id,
                    url: resource.url
                  });
                  return content.substr(offset, size);
                }
              }
            }
          }
        }
      }
    }
  }
};

function findRoute(path) {
  let route = router;
  for (let segment of path.split("/")) {
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
  } else if (route.read) {
    // default file attrs
    return {
      st_mode: unix.S_IFREG | 0444,
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

async function release(path, fh) {
  let route = findRoute(path);
  if (route.release) return route.release(path, fh);
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

let ws;
async function onmessage(event) {
  const req = JSON.parse(event.data);
  console.log('req', req);

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
      const buf = await read(req.path, req.fh, req.size, req.offset)
      response = {
        op: 'read',
        buf
      };

    } else if (req.op === 'release') {
      await release(req.path, req.fh);
      response = {
        op: 'release'
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

  response.id = req.id;
  console.log('resp', response);
  ws.send(JSON.stringify(response));
};

function tryConnect() {
  ws = new WebSocket("ws://localhost:8888");
  updateToolbarIcon();
  ws.onopen = ws.onclose = updateToolbarIcon;
  ws.onmessage = onmessage;
}

function updateToolbarIcon() {
  if (ws && ws.readyState == 1) { // OPEN
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

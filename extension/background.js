const ws = new WebSocket("ws://localhost:8888");

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

function sendDebuggerCommand(tab, method, commandParams) {
  return new Promise(resolve => chrome.debugger.sendCommand({tabId: id}, method, commandParams, resolve));
}

const fhManager = (function() {
  const handles = {};
  let nextFh = 0;
  return {
    allocate(obj) { // -> fh
      const fh = nextFh++;
      handles[fh] = obj;
      return fh;
    },
    ref(fh) {
      if (!handles[fh]) throw new UnixError(unix.EIO);
      return handles[fh];
    },
    free(fh) {
      delete handles[fh];
    }
  };
})();

// tabs/by-id/ID/title
// tabs/by-id/ID/url
// tabs/by-id/ID/console
// tabs/by-id/ID/mem (?)
// tabs/by-id/ID/cpu (?)
// tabs/by-id/ID/screenshot.png
// tabs/by-id/ID/printed.pdf
// tabs/by-id/ID/control
// tabs/by-id/ID/sources/

function pathComponent(path, i) {
  const components = path.split('/');
  return components[i >= 0 ? i : components.length + i];
}

const router = {
  "tabs": {
    "by-id": {
      async readdir() {
        const tabs = await queryTabs();
        return tabs.map(tab => String(tab.id));
      },

      "*": {
        "url": {
          async getattr() {
            return {
              st_mode: unix.S_IFREG | 0444,
              st_nlink: 1,
              st_size: 100 // FIXME
            };
          },
          async open(path) {
            return 0;
          },
          async read(path, fh, size, offset) {
            const tab = await getTab(parseInt(pathComponent(path, -2)));
            return (tab.url + "\n").substr(offset, size);
          },
          async release(path, fh) {}
        },
        "title": {
          async getattr() {
            return {
              st_mode: unix.S_IFREG | 0444,
              st_nlink: 1,
              st_size: 1000 // FIXME
            };
          },
          async open(path) {
            return 0;
          },
          async read(path, fh, size, offset) {
            const tab = await getTab(parseInt(pathComponent(path, -2)));
            return (tab.title + "\n").substr(offset, size);
          },
          async release(path, fh) {}
        },
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
  } else {
    return {
      st_mode: unix.S_IFDIR | 0755,
      st_nlink: 3
    };
  }
}

async function readdir(path) {
  let route = findRoute(path);
  if (route.readdir) return route.readdir(path);
  return Object.keys(route);
}

async function open(path) {
  let route = findRoute(path);
  if (route.open) return route.open(path);
}

async function read(path, fh, size, offset) {
  let route = findRoute(path);
  if (route.read) return route.read(path, fh, size, offset);
}

async function release(path, fh) {
  let route = findRoute(path);
  if (route.read) return route.release(path, fh);
}

ws.onmessage = async function(event) {
  const req = JSON.parse(event.data);

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

    } else if (req.op === 'readdir') {
      response = {
        op: 'readdir',
        entries: [".", "..", ...(await readdir(req.path))]
      };

    } else if (req.op === 'read') {
      const buf = await read(req.path, req.fh, req.size, req.offset)
      response = {
        op: 'read',
        buf,
        size: buf.length
      };

    } else if (req.op === 'release') {
      await release(req.path, req.fh);
      response = {
        op: 'release'
      };
    }
  } catch (e) {
    response = {
      op: req.op,
      error: e instanceof UnixError ? e.error : unix.EIO
    }
  }
  /* console.timeEnd(req.op + ':' + req.path);*/

  response.id = req.id;
  ws.send(JSON.stringify(response));
};

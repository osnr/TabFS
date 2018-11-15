const ws = new WebSocket("ws://localhost:8888");

const ops = {
  NONE: 0,
  GETATTR: 1,
  READDIR: 2
};
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

function queryTabs() {
  return new Promise((resolve, reject) => chrome.tabs.query({}, resolve));
}

const router = {
  "tabs": {
    "by-id": {
      async readdir() {
        const tabs = await queryTabs();
        return tabs.map(tab => String(tab.id));
      },

      "*": {
        async getattr() {
          return {
            st_mode: unix.S_IFREG | 0444,
            st_nlink: 1,
            st_size: 10 // FIXME
          };
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
  }
  return route;
}

async function readdir(path) {
  let route = findRoute(path);

  if (route.readdir) {
    return route.readdir();
  }
  return Object.keys(route);
}

async function getattr(path) {
  let route = findRoute(path);

  if (route.getattr) {
    return route.getattr();
  } else {
    return {
      st_mode: unix.S_IFDIR | 0755,
      st_nlink: 3
    };
  }
  /* 
   * const response = {};
   * if (path === "/" || path === "/tabs" || path === "/tabs/by-title" || path === "/tabs/by-id") {
   *   response.st_mode = unix.S_IFDIR | 0755;
   *   response.st_nlink = 3;

   * } else if (path === "/tabs/hello.txt") {
   *  
   * } else {
   *   response.error = unix.ENOENT;
   * }
   * return response;*/
}

ws.onmessage = async function(event) {
  const req = JSON.parse(event.data);
  console.log('req', Object.entries(ops).find(([op, opcode]) => opcode === req.op)[0], req);

  let response;
  if (req.op === ops.READDIR) {
    response = {
      op: ops.READDIR,
      entries: [".", "..", ...(await readdir(req.path))]
    };

  } else if (req.op === ops.GETATTR) {
    response = {
      op: ops.GETATTR,
      st_mode: 0,
      st_nlink: 0,
      st_size: 0,
      ...(await getattr(req.path))
    };
  }

  console.log('response', Object.entries(ops).find(([op, opcode]) => opcode === response.op)[0], response);
  ws.send(JSON.stringify(response));
};

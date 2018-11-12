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

function readdir(path) {
  if (path === "/") {
    return ["tabs"];

  } else if (path === "/tabs") {
    return ["hello.txt"];
  }
}

function getattr(path) {
  const response = {};
  if (path === "/" || path === "/tabs") {
    response.st_mode = unix.S_IFDIR | 0755;
    response.st_nlink = 3;

  } else if (path === "/tabs/hello.txt") {
    response.st_mode = unix.S_IFREG | 0444;
    response.st_nlink = 1;
    response.st_size = 10; // FIXME

  } else {
    response.error = unix.ENOENT;
  }
  return response;
}

ws.onmessage = function(event) {
  const req = JSON.parse(event.data);
  console.log('req', Object.entries(ops).find(([op, opcode]) => opcode === req.op)[0], req);

  let response;
  if (req.op === ops.READDIR) {
    response = {
      op: ops.READDIR,
      entries: [".", "..", ...readdir(req.path)]
    };

  } else if (req.op === ops.GETATTR) {
    response = {
      op: ops.GETATTR,
      st_mode: 0,
      st_nlink: 0,
      st_size: 0,
      ...getattr(req.path)
    };
  }

  console.log('response', Object.entries(ops).find(([op, opcode]) => opcode === response.op)[0], response);
  ws.send(JSON.stringify(response));
};

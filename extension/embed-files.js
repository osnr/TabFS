if (chrome.extension.getBackgroundPage) {
  // When running in background script:
  // 'Server' that manages the files for all tabs.

  const locations = {};
  // FIXME: garbage-collect old locations

  browser.runtime.onMessage.addListener(async (request, sender) => {
    async function ls() {
      let {entries} = await Routes["/tabs/by-id/#TAB_ID"]
          .readdir({path: `/tabs/by-id/${sender.tab.id}`});
      entries = await Promise.all(entries.map(filename => {
        let path = `/tabs/by-id/${sender.tab.id}/${filename}`;
        return doRequest({op: 'getattr', path: (function() {
          let normalizedPath = path;
          if (filename === '.') {
            normalizedPath = `/tabs/by-id/${sender.tab.id}`;
          } else if (filename === '..') {
            normalizedPath = `/tabs/by-id`;
          }
          return normalizedPath;
        })()})
          .then(stat => ({ ...stat, ...(locations[path] || {}),
                           filename, path }));
      }));
      await browser.tabs.sendMessage(sender.tab.id, entries);
    }

    if (request.op === 'LS') {
      await ls();

    } else if (request.op === 'OPEN') {
      chrome.tabs.create({
	url: `file:///Users/osnr/t${request.path}`,
	index: sender.tab.index + 1,
      });

    } else if (request.op === 'RELOCATE') {
      locations[request.path] = {x: request.x, y: request.y};

    } else if (request.op === 'CREATE') {
      const path = `/tabs/by-id/${sender.tab.id}/${request.filename}`;
      await doRequest({op: 'mknod', path });
      const {fh} = await doRequest({op: 'open', path });
      await doRequest({op: 'write', path, fh, buf: request.buf, offset: 0 });
      await doRequest({op: 'release', path, fh });
      locations[path] = {x: request.x, y: request.y};

      await ls();
    }
  });

} else {
  // When running in page:
  // Content script that injects a file manager into the page.

  document.body.insertAdjacentHTML('beforeend', `
<style>
.--tabfs-file-container .--tabfs-file {
  /* fixed makes sense if it's a property of the tab; */
  /* absolute would make more sense if it's a property of the page? */
  position: fixed; top: 0; left: 0;
  z-index: 10000;
  cursor: move;
  user-select: none; -webkit-user-select: none;
  font: 12px system-ui, -apple-system;
  background-color: white;
}

.--tabfs-file-container .--tabfs-file::before {
  display: block; font-size: 48px;
}
.--tabfs-file-container .--tabfs-file::before {
  content: '📄'; 
}
.--tabfs-file-container .--tabfs-file--directory::before {
  content: '📁'; 
}
</style>

<div class="--tabfs-file-container">
</div>
`);
  const container = document.getElementsByClassName('--tabfs-file-container')[0];

  const icons = {};

  let frontierX = 0, frontierY = 0;
  const addFile = function(stat) {
    let x = stat.x; let y = stat.y;
    if (!('x' in stat)) {
      x = frontierX; frontierX += 64;
      y = 0;
      chrome.runtime.sendMessage({op: 'RELOCATE', path: stat.path,
                                  x, y});
    }

    container.insertAdjacentHTML('beforeend', `
<div class="--tabfs-file ${stat.st_mode & 040000 !== 0 ? '--tabfs-file--directory' : ''}">${stat.filename}</div>
`);
    const icon = container.lastElementChild;
    icon.style.left = `${x}px`; icon.style.top = `${y}px`; 

    // from https://htmldom.dev/make-a-draggable-element/:

    // The current position of mouse
    let mouseX = 0;
    let mouseY = 0;

    // Handle the mousedown event
    // that's triggered when user drags the element
    const mouseDownHandler = function(e) {
      // Get the current mouse position
      mouseX = e.clientX;
      mouseY = e.clientY;
      
      // Attach the listeners to `document`
      document.addEventListener('mousemove', mouseMoveHandler);
      document.addEventListener('mouseup', mouseUpHandler);

      e.preventDefault();
    };

    const mouseMoveHandler = function(e) {
      // How far the mouse has been moved
      const dx = e.clientX - mouseX;
      const dy = e.clientY - mouseY;

      // Set the position of element
      icon.style.top = `${icon.offsetTop + dy}px`; 
      icon.style.left = `${icon.offsetLeft + dx}px`;

      // Reassign the position of mouse
      mouseX = e.clientX;
      mouseY = e.clientY;

      e.preventDefault();
    };

    const mouseUpHandler = function() {
      // Remove the handlers of `mousemove` and `mouseup`
      document.removeEventListener('mousemove', mouseMoveHandler);
      document.removeEventListener('mouseup', mouseUpHandler);

      chrome.runtime.sendMessage({op: 'RELOCATE', path: stat.path,
                                  x: mouseX, y: mouseY});
    };

    icon.addEventListener('mousedown', mouseDownHandler);
    icon.addEventListener('dblclick', () => {
      chrome.runtime.sendMessage({op: 'OPEN', path: stat.path});
      return false;
    });
  };

  // ask for what the files are
  chrome.runtime.onMessage.addListener(function(entries) {
    container.innerHTML = '';
    entries.forEach(stat => addFile(stat));
  });
  chrome.runtime.sendMessage({op: 'LS'});
  
  document.body.addEventListener('dragenter', function(e) {
    e.preventDefault();
  });
  document.body.addEventListener('dragover', function(e) {
    e.preventDefault();
  });
  document.body.addEventListener('dragleave', function(e) {
    e.preventDefault();
  });

  document.body.addEventListener('drop', async function(e) {
    e.preventDefault(); // stops browser nav to that file
    for (let file of [...e.dataTransfer.files]) {
      // FIXME: this doesn't work for non-text files
      // (some encoding issue)
      const buf = await file.text(); 
      chrome.runtime.sendMessage({ op: 'CREATE',
                                   filename: file.name,
                                   x: e.clientX, y: e.clientY,
                                   buf });
    }
  });
}

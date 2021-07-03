if (chrome.extension.getBackgroundPage) {
  // When running in background script:
  // 'Server' that manages the files for all tabs.

  // TODO: can I trigger 1. nav to Finder and 2. nav to Terminal from toolbar click?
  // accept requests from the page

  browser.runtime.onMessage.addListener(async (request, sender) => {
    let {entries} = await Routes["/tabs/by-id/#TAB_ID"]
        .readdir({path: `/tabs/by-id/${sender.tab.id}`});
    entries = await Promise.all(entries.map(filename => {
      let path = `/tabs/by-id/${sender.tab.id}/${filename}`;
      if (filename === '.') {
        path = `/tabs/by-id/${sender.tab.id}`;
      } else if (filename === '..') {
        path = `/tabs/by-id`;
      }
      return doRequest({op: 'getattr', path})
        .then(stat => ({ ...stat, filename }));
    }));
    // TODO: report back not as reply, but as general msg
    return entries;
  });

  // send the file list to the page

  // receive events from the page of
  // they dragged a new file in,
  // or they moved a file,
  // or they double-clicked a file

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
  const addFile = function(stat, x, y, file) {
    if (!x) {
      x = frontierX; frontierX += 64;
      y = 0;
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

      // TODO: report into extension
    };

    icon.addEventListener('mousedown', mouseDownHandler);
  };

  // ask for what the files are
  chrome.runtime.sendMessage({hello: 'hello'}, function(response) {
    response.forEach(stat => addFile(stat));
  });
  
  document.body.addEventListener('dragenter', function(e) {
    e.preventDefault();
  });
  document.body.addEventListener('dragover', function(e) {
    e.preventDefault();
  });
  document.body.addEventListener('dragleave', function(e) {
    e.preventDefault();
  });

  document.body.addEventListener('drop', function(e) {
    // bubble thing
    e.preventDefault(); // stops browser nav to that file
    for (let file of [...e.dataTransfer.files]) {
      addFile(file.name, e.clientX, e.clientY, file);
    }
  });
}

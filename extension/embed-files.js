// Content script that injects a file manager into tabs.

document.body.insertAdjacentHTML('beforeend', `
<style>
.--tabfs-file-container .--tabfs-file {
  position: absolute; top: 0; left: 0;
  z-index: 10000;
  cursor: move;
  user-select: none; -webkit-user-select: none;
  font: 12px system-ui, -apple-system;
  background-color: white;
}

body.dragging::after {
  background-color: green; opacity: 0.5; 
  content: 'hello'; display: block;
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
}
</style>

<div class="--tabfs-file-container">
</div>
`);
const container = document.getElementsByClassName('--tabfs-file-container')[0];

const icons = {};

let frontierX = 0, frontierY = 0;
function addFile(name, x, y, file) {
  if (!x) {
    x = frontierX; frontierX += 64;
    y = 0;
  }

  container.insertAdjacentHTML('beforeend', `
<div class="--tabfs-file">${name}</div>
`);
  const icon = container.lastElementChild;
  icon.style.left = x; icon.style.top = y; 

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
  };

  icon.addEventListener('mousedown', mouseDownHandler);
}

['a.js', 'b.html', 'c.js'].forEach(name => addFile(name));

// make the files draggable
// remember their positions on rerender, like do a merge when we get a new set of files

// from https://htmldom.dev/highlight-an-element-when-dragging-a-file-over-it/:

document.body.addEventListener('dragenter', function(e) {
  e.preventDefault();
  e.target.classList.add('dragging');
});
document.body.addEventListener('dragover', function(e) {
  e.preventDefault();
});
document.body.addEventListener('dragleave', function(e) {
  e.preventDefault();
  e.target.classList.remove('dragging');
});

document.body.addEventListener('drop', function(e) {
  e.preventDefault();
  e.target.classList.remove('dragging');

  for (let file of [...e.dataTransfer.files]) {
    addFile(file.name, e.clientX, e.clientY, file);
  }
});

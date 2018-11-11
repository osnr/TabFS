const ws = new WebSocket("ws://localhost:8888");

ws.onmessage = function(event) {
  const req = JSON.parse(event.data);

  const response = {
    names: [".", "..", "hi.txt"]
  };

  ws.send(JSON.stringify(response));
};

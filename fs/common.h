// common provides an interface for tabfs.c (which talks to FUSE) to
// talk to ws.c (which talks to the browser over WebSocket).

#ifndef COMMON_H
#define COMMON_H

#include <sys/types.h>

#define DEBUG(...)

void common_init();

typedef int (*fd_set_filler_fn_t)(fd_set*, fd_set*, fd_set*);

// All send and receive calls are blocking!

void common_send_tabfs_to_ws(char *request_data);
// This function is called by the ws thread; it blocks waiting for
// tabfs thread to send a request _from FUSE_, which means that the ws
// thread wouldn't be able to hear about events _from the browser_
// while blocked here (including important ones, like 'the browser
// wants to connect to us!').
//
// The hack solution is that ws passes a function `filler` to add the
// WebSocket file descriptors to the set that
// `common_receive_tabfs_to_ws` polls, so it _also_ waits on
// _browser-side_ events from the WebSocket file descriptors, not just
// FUSE-side events.
char *common_receive_tabfs_to_ws(fd_set_filler_fn_t filler);

void common_send_ws_to_tabfs(char *response_data);
char *common_receive_ws_to_tabfs();

#endif

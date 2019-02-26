#include <unistd.h>
#include <stdlib.h>
#include <sys/types.h>

#include <sys/time.h>
#include <stdio.h>
#include <signal.h>

#include "common.h"

static int tabfs_to_ws[2];
static int ws_to_tabfs[2];

void common_init() {
    if (pipe(tabfs_to_ws)) exit(1);
    if (pipe(ws_to_tabfs)) exit(1);
}

// FIXME: we probably need memory fences here?? especially on
// non-x86?? idk
// see https://stackoverflow.com/questions/35837539/does-the-use-of-an-anonymous-pipe-introduce-a-memory-barrier-for-interthread-com

void common_send_tabfs_to_ws(char *request_data) {
    write(tabfs_to_ws[1], &request_data, sizeof(request_data));
}

char *common_receive_tabfs_to_ws(fd_set_filler_fn_t filler) {
    fd_set read_fds, write_fds, except_fds;
    FD_ZERO(&read_fds);
    FD_ZERO(&write_fds);
    FD_ZERO(&except_fds);

    int max_fd = filler(&read_fds, &write_fds, &except_fds);

    FD_SET(tabfs_to_ws[0], &read_fds);
    if (tabfs_to_ws[0] > max_fd) { max_fd = tabfs_to_ws[0]; }

    struct timeval timeout;
    timeout.tv_sec = 0;
    timeout.tv_usec = 200000;

    select(max_fd + 1, &read_fds, &write_fds, &except_fds, &timeout);

    if (!FD_ISSET(tabfs_to_ws[0], &read_fds)) {
        // We can't read from tabfs_to_ws right now. Could be that it
        // timed out, could be that we got a websocket event instead,
        // whatever.

        return NULL;
    }

    char *request_data;
    read(tabfs_to_ws[0], &request_data, sizeof(request_data));

    return request_data;
}

void common_send_ws_to_tabfs(char *response_data) {
    write(ws_to_tabfs[1], &response_data, sizeof(response_data));
}
char *common_receive_ws_to_tabfs() {
    char *response_data;
    read(ws_to_tabfs[0], &response_data, sizeof(response_data));

    return response_data;
}

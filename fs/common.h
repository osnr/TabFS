#ifndef COMMON_H
#define COMMON_H

#include <sys/types.h>

#define DEBUG(...)

void common_init();

typedef int (*fd_set_filler_fn_t)(fd_set*, fd_set*, fd_set*);

void common_send_tabfs_to_ws(char *request_data);
char *common_receive_tabfs_to_ws(fd_set_filler_fn_t filler);

void common_send_ws_to_tabfs(char *response_data);
char *common_receive_ws_to_tabfs();

#endif

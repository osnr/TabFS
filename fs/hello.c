#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>
#include <fuse.h>

#define WBY_STATIC
#define WBY_IMPLEMENTATION
#define WBY_USE_FIXED_TYPES
#define WBY_USE_ASSERT
#include "mmx/web.h"

#include "cJSON/cJSON.h"
#include "cJSON/cJSON.c"

struct wby_server server;
struct wby_con *con = NULL;

pthread_mutex_t request_data_mutex = PTHREAD_MUTEX_INITIALIZER;
char *request_data = NULL;

enum opcode {
    NONE = 0,

    GETATTR,
    OPEN,
    READDIR,
    READ
};

pthread_cond_t response_cv = PTHREAD_COND_INITIALIZER;
pthread_mutex_t response_mutex = PTHREAD_MUTEX_INITIALIZER;
cJSON *response = NULL;

static const char  *file_path      = "/hello.txt";
static const char   file_content[] = "Hello World!\n";
static const size_t file_size      = sizeof(file_content)/sizeof(char) - 1;

static void dispatch_send_req(cJSON *req) {
  pthread_mutex_lock(&request_data_mutex);

  request_data = cJSON_Print(req);
  printf("%s\n", request_data);

  pthread_mutex_unlock(&request_data_mutex);
}

void send_req_if_any() {
  pthread_mutex_lock(&request_data_mutex);

  if (con == NULL || request_data == NULL) goto done;

  wby_frame_begin(con, WBY_WSOP_TEXT_FRAME);
  wby_write(con, request_data, strlen(request_data));
  wby_frame_end(con);

  free(request_data);
  request_data = NULL;

 done:
  pthread_mutex_unlock(&request_data_mutex);
}

static cJSON *await_response() {
  pthread_mutex_lock(&response_mutex);

  response = NULL;
  while (response == NULL) {
    pthread_cond_wait(&response_cv, &response_mutex);
  }

  cJSON *resp = response;
  pthread_mutex_unlock(&response_mutex);

  return resp;
}

#define MAKE_REQ(op, req_body, resp_handler) \
  do { \
    int ret = -1;                                     \
    cJSON *req = NULL;                              \
    cJSON *resp = NULL;                           \
                                                  \
    pthread_mutex_lock(&request_data_mutex); \
    int disconnected = (con == NULL); \
    pthread_mutex_unlock(&request_data_mutex); \
    if (disconnected) { ret = -EIO; goto done; }        \
    \
    req = cJSON_CreateObject(); \
    cJSON_AddNumberToObject(req, "op", (int) op);        \
    req_body \
    \
    dispatch_send_req(req); \
    \
    resp = await_response();\
    \
    cJSON *error_item = cJSON_GetObjectItemCaseSensitive(resp, "error"); \
    if (error_item) { \
      ret = -error_item->valueint; \
      if (ret != 0) goto done; \
    } \
    \
    resp_handler \
    \
    ret = 0; \
done: \
    if (req != NULL) cJSON_Delete(req); \
    if (resp != NULL) cJSON_Delete(resp); \
    return ret;                               \
  } while (0)

#define JSON_GET_PROP_INT(lvalue, key) \
  do { \
    lvalue = cJSON_GetObjectItemCaseSensitive(resp, key)->valueint;     \
  } while (0)

static int
hello_getattr(const char *path, struct stat *stbuf)
{
    memset(stbuf, 0, sizeof(struct stat));
    printf("\n\ngetattr(%s)\n", path);

    MAKE_REQ(GETATTR, {
        cJSON_AddStringToObject(req, "path", path);
    }, {
        JSON_GET_PROP_INT(stbuf->st_mode, "st_mode");
        JSON_GET_PROP_INT(stbuf->st_nlink, "st_nlink");
        JSON_GET_PROP_INT(stbuf->st_size, "st_size");
        printf("returning re getattr(%s)\n", path);
    });
}

static int
hello_open(const char *path, struct fuse_file_info *fi)
{
    MAKE_REQ(OPEN, {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        cJSON *fh_item = cJSON_GetObjectItemCaseSensitive(resp, "fh");
        if (fh_item) fi->fh = fh_item->valueint;
    });
}

static int
hello_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
              off_t offset, struct fuse_file_info *fi)
{
    printf("\n\nreaddir(%s)\n", path);
    
    // send {op: READDIR, path} to the websocket handler
    MAKE_REQ(READDIR, {
        cJSON_AddStringToObject(req, "path", path);
    }, {
        cJSON *entries = cJSON_GetObjectItemCaseSensitive(resp, "entries");
        cJSON *entry;
        cJSON_ArrayForEach(entry, entries) {
            filler(buf, cJSON_GetStringValue(entry), NULL, 0);
            printf("entry: [%s]\n", cJSON_GetStringValue(entry));
        }
    });
}

static int
hello_read(const char *path, char *buf, size_t size, off_t offset,
           struct fuse_file_info *fi)
{
    MAKE_REQ(OPEN, {
        cJSON_AddStringToObject(req, "path", path);
        cJSON_AddNumberToObject(req, "size", size);
        cJSON_AddNumberToObject(req, "offset", offset);

        cJSON_AddNumberToObject(req, "fh", fi->fh);
        cJSON_AddNumberToObject(req, "flags", fi->flags);
    }, {
        
    });

    if (strcmp(path, file_path) != 0)
        return -ENOENT;

    if (offset >= file_size) /* Trying to read past the end of file. */
        return 0;

    if (offset + size > file_size) /* Trim the read to the file size. */
        size = file_size - offset;

    memcpy(buf, file_content + offset, size); /* Provide the content. */

    return size;
}

static struct fuse_operations hello_filesystem_operations = {
    .getattr = hello_getattr, /* To provide size, permissions, etc. */
    .open    = hello_open,    /* To enforce read-only access.       */
    .read    = hello_read,    /* To provide file content.           */
    .readdir = hello_readdir, /* To provide directory listing.      */
};

static int
dispatch(struct wby_con *connection, void *userdata)
{
    return 1;
}

static int
websocket_connect(struct wby_con *connection, void *userdata)
{
    /* connection bound userdata */
    connection->user_data = NULL;
    if (0 == strcmp(connection->request.uri, "/"))
        return 0;
    return 1;
}

static void
websocket_connected(struct wby_con *connection, void *userdata)
{
    printf("WebSocket connected\n");
    con = connection;
}

static int
websocket_frame(struct wby_con *connection, const struct wby_frame *frame, void *userdata)
{
    unsigned char data[131072] = {0};

    int i = 0;
    printf("WebSocket frame incoming\n");
    printf("  Frame OpCode: %d\n", frame->opcode);
    printf("  Final frame?: %s\n", (frame->flags & WBY_WSF_FIN) ? "yes" : "no");
    printf("  Masked?     : %s\n", (frame->flags & WBY_WSF_MASKED) ? "yes" : "no");
    printf("  Data Length : %d\n", (int) frame->payload_length);

    if ((unsigned long) frame->payload_length > sizeof(data)) {
        printf("Data too long!\n");
        exit(1);
    }
    
    while (i < frame->payload_length) {
        unsigned char buffer[16];
        int remain = frame->payload_length - i;
        size_t read_size = remain > (int) sizeof buffer ? sizeof buffer : (size_t) remain;
        size_t k;

        printf("%08x ", (int) i);
        if (0 != wby_read(connection, buffer, read_size))
            break;
        for (k = 0; k < read_size; ++k)
            printf("%02x ", buffer[k]);
        for (k = read_size; k < 16; ++k)
            printf("   ");
        printf(" | ");
        for (k = 0; k < read_size; ++k)
            printf("%c", isprint(buffer[k]) ? buffer[k] : '?');
        printf("\n");
        for (k = 0; k < read_size; ++k)
          data[i + k] = buffer[k];
        i += (int)read_size;
    }

    if ((int) strlen((const char *) data) != frame->payload_length) {
      printf("Null in data! [%s]\n", data);
    }

    pthread_mutex_lock(&response_mutex);
    response = cJSON_Parse((const char *) data);
    pthread_cond_signal(&response_cv);
    pthread_mutex_unlock(&response_mutex);

    return 0;
}

static void
websocket_closed(struct wby_con *connection, void *userdata)
{
    printf("WebSocket closed\n");
    con = NULL;
}

static void
test_log(const char* text)
{
    printf("[debug] %s\n", text);
}

void *websocket_main(void *threadid)
{
    void *memory = NULL;
    wby_size needed_memory = 0;

    struct wby_config config;
    memset(&config, 0, sizeof config);
    config.userdata = NULL;
    config.address = "127.0.0.1";
    config.port = 8888;
    config.connection_max = 4;
    config.request_buffer_size = 2048;
    config.io_buffer_size = 8192;
    config.log = test_log;
    config.dispatch = dispatch;
    config.ws_connect = websocket_connect;
    config.ws_connected = websocket_connected;
    config.ws_frame = websocket_frame;
    config.ws_closed = websocket_closed;
    
    wby_init(&server, &config, &needed_memory);
    memory = calloc(needed_memory, 1);
    wby_start(&server, memory);

    printf("Awaiting WebSocket connection from Chrome extension.\n");
    for (;;) {
        send_req_if_any();

        wby_update(&server);
    }

    wby_stop(&server);
    free(memory);
#if defined(_WIN32)
    WSACleanup();
#endif
    return 0;
}

int
main(int argc, char **argv)
{
    pthread_t websocket_thread;
    pthread_create(&websocket_thread, NULL, websocket_main, NULL);
    return fuse_main(argc, argv, &hello_filesystem_operations, NULL);

}

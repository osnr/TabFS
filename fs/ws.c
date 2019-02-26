// WebSocket server.
// Side thread that gets spawned.

#define WBY_STATIC
#define WBY_IMPLEMENTATION
#define WBY_USE_FIXED_TYPES
#define WBY_USE_ASSERT
#include "mmx/web.h"

#include "common.h"

static struct wby_server server;
static struct wby_con *con = NULL;

static int fill_fd_set_with_ws_sockets(fd_set *read_fds, fd_set *write_fds, fd_set *except_fds) {
    // Based on web.h:1936 (start of wby_update)

    int max_fd = 0;
    FD_SET(server.socket, read_fds);
    FD_SET(server.socket, except_fds);
    max_fd = WBY_SOCK(server.socket);

    if (con == NULL) { return max_fd; }

    struct wby_connection *conn = (struct wby_connection *) con;
    wby_socket socket = WBY_SOCK(conn->socket);
    FD_SET(socket, read_fds);
    FD_SET(socket, except_fds);
    if (conn->state == WBY_CON_STATE_SEND_CONTINUE) {
        FD_SET(socket, write_fds);
    }

    if (socket > max_fd) { max_fd = socket; }
    return max_fd;
}

static void receive_tabfs_request_then_send_to_browser() {
    char *request_data = common_receive_tabfs_to_ws(fill_fd_set_with_ws_sockets);
    if (request_data == NULL) {
        return;
    }

    if (con == NULL) {
        common_send_ws_to_tabfs(NULL);
        return;
    }

    wby_frame_begin(con, WBY_WSOP_TEXT_FRAME);
    wby_write(con, request_data, strlen(request_data));
    wby_frame_end(con);

    // Was allocated by sender (tabfs.c, send_request_then_await_response).
    free(request_data);
}

static int
dispatch(struct wby_con *connection, void *userdata) {
    return 1;
}

static int
websocket_connect(struct wby_con *connection, void *userdata) {
    /* connection bound userdata */
    connection->user_data = NULL;
    if (0 == strcmp(connection->request.uri, "/"))
        return 0;
    return 1;
}

static void
websocket_connected(struct wby_con *connection, void *userdata) {
    printf("WebSocket connected\n");
    con = connection;
}

#define MAX_DATA_LENGTH 131072

static int
websocket_frame(struct wby_con *connection, const struct wby_frame *frame, void *userdata)
{
    // Will be freed at receiver (tabfs.c, send_request_then_await_response).
    unsigned char *data = calloc(1, MAX_DATA_LENGTH); 

    int i = 0;
    DEBUG("WebSocket frame incoming\n");
    DEBUG("  Frame OpCode: %d\n", frame->opcode);
    DEBUG("  Final frame?: %s\n", (frame->flags & WBY_WSF_FIN) ? "yes" : "no");
    DEBUG("  Masked?     : %s\n", (frame->flags & WBY_WSF_MASKED) ? "yes" : "no");
    DEBUG("  Data Length : %d\n", (int) frame->payload_length);

    if ((unsigned long) frame->payload_length > MAX_DATA_LENGTH) {
        printf("Data too long!\n");
        exit(1);
    }
    
    while (i < frame->payload_length) {
        unsigned char buffer[16];
        int remain = frame->payload_length - i;
        size_t read_size = remain > (int) sizeof buffer ? sizeof buffer : (size_t) remain;
        size_t k;

        DEBUG("%08x ", (int) i);
        if (0 != wby_read(connection, buffer, read_size))
            break;
        for (k = 0; k < read_size; ++k)
            DEBUG("%02x ", buffer[k]);
        for (k = read_size; k < 16; ++k)
            DEBUG("   ");
        DEBUG(" | ");
        for (k = 0; k < read_size; ++k)
            DEBUG("%c", isprint(buffer[k]) ? buffer[k] : '?');
        DEBUG("\n");
        for (k = 0; k < read_size; ++k)
            data[i + k] = buffer[k];
        i += (int)read_size;
    }

    if ((int) strlen((const char *) data) != frame->payload_length) {
        printf("Null in data! [%s]\n", data);
    }

    common_send_ws_to_tabfs((char *) data);

    return 0;
}

static void websocket_closed(struct wby_con *connection, void *userdata) {
    printf("WebSocket closed\n");
    
    if (con == connection) con = NULL;
}

static void test_log(const char* text) {
    DEBUG("[debug] %s\n", text);
}

void *websocket_main(void *threadid) {
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
        receive_tabfs_request_then_send_to_browser();
        wby_update(&server); // We receive stuff from the browser here.
    }

    wby_stop(&server);
    free(memory);
#if defined(_WIN32)
    WSACleanup();
#endif
    return 0;
}

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>

int main() {
    FILE *log = fopen("log.txt", "w");
    fprintf(log, "hello\n"); fflush(log);

    for (;;) {
        char *outMsg = "{\"text\":\"This is a response message\"}";
        unsigned int outLen = strlen(outMsg);
        char *bOutLen = (char *)&outLen;
        write(1, bOutLen, 4); // 1 is stdout
        write(1, outMsg, outLen);
        fflush(stdout);
        fprintf(log, "wrote msg\n"); fflush(log);

        char bInLen[4];
        read(0, bInLen, 4); // 0 is stdin
        unsigned int inLen = *(unsigned int *)bInLen;
        char *inMsg = (char *)malloc(inLen);
        read(0, inMsg, inLen);
        inMsg[inLen] = '\0';
        fprintf(log, "msg: [%s]\n", inMsg); fflush(log);
        free(inMsg);
 
    }
    return 0;
}

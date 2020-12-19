//usr/bin/env cc -o test "$0" && ./test; exit

// (run this file directly with `./test.c` in most shells; if that
// doesn't work, run it with `sh test.c`)

#include <stdio.h>
#include <stdlib.h>
#include <assert.h>

int file_contents_equal(char* path, char* contents) {
    char command[200];
    snprintf(command, sizeof(command),
             "[ \"%s\" == \"$(cat %s)\" ]", contents, path);
    return system(command) == 0;
}

// integration tests
int main() {
    assert(system("echo about:blank > fs/mnt/tabs/create") == 0);
    assert(file_contents_equal("fs/mnt/tabs/last-focused/url", "about:blank"));
    assert(system("file fs/mnt/tabs/last-focused/screenshot.png") == 0);
    
    assert(1); printf("Done!\n"); 
}

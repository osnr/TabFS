//usr/bin/env cc -o test "$0" && ./test; exit
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>

// integration tests
int main() {
    assert(system("echo about:blank > fs/mnt/tabs/create") == 0);
    
    assert(1); printf("Done!\n"); 
}

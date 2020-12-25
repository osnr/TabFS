//usr/bin/env cc -o test "$0" && ./test; exit

// (run this file directly with `./test.c` in most shells; if that
// doesn't work, run it with `sh test.c`)

#include <stdio.h>
#include <stdlib.h>
#include <assert.h>
#include <wordexp.h>

int file_contents_equal(char* path, char* contents) {
    // hehe: https://twitter.com/ianh_/status/1340450349065244675
    setenv("path", path, 1);
    setenv("contents", contents, 1);
    return system("[ \"$contents\" == \"$(cat \"$path\")\" ]") == 0;
}

char* expand(char* phrase) {
    wordexp_t result; assert(wordexp(phrase, &result, 0) == 0);
    return result.we_wordv[0];
}

// integration tests
int main() {
    assert(system("echo about:blank > fs/mnt/tabs/create") == 0);
    assert(file_contents_equal("fs/mnt/tabs/last-focused/url.txt", "about:blank"));
    assert(system("file fs/mnt/tabs/last-focused/screenshot.png") == 0); // slow
    assert(system("echo remove > fs/mnt/tabs/last-focused/control") == 0);

    assert(file_contents_equal(expand("fs/mnt/extensions/TabFS*/enabled"), "true"));

    assert(1); printf("Done!\n"); 
}

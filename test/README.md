# test

Two separate test 'suites': one in `test.js` that uses node, and one
in `test.c` that is an integration test that actually tests against
the extension in browser.

Right now, you need to have Chrome open (I haven't tried Firefox or
Safari), and you'll want to make sure a window other than the
extension console is focused (the console is non-debuggable, so it
breaks the test).

Run `make` in this folder. 

// Every page with long content (long names, long field names) on the smallest phone and a desktop, and with unbroken
// content (long words without spaces) on a phone.
// (the pages and the test are in lib/matrix.js)

matrixTests("long", ["phone-small", "desktop"]);
matrixTests("unbroken", ["phone"]);

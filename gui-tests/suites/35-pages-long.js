// Every page with long content (long names, long field names), at every window size but wide (that one is in suite 39).
// (the pages and the test are in lib/matrix.js)

matrixTests("long", MATRIX_VIEWPORTS.filter((vp) => vp !== "wide"));

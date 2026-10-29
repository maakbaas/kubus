// Every page with typical content on a phone, a desktop and a wide window: the layout audit passes, no layout shifts while loading.
// (the pages and the test are in lib/matrix.js)

matrixTests("typical", ["phone", "desktop", "wide"]);

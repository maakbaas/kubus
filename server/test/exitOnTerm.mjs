// Preloaded (node --import) into the server process when coverage is collected: V8 writes a process's
// coverage when it exits, and the server has no SIGTERM handler, so stop() would kill it without a dump.
process.on("SIGTERM", () => process.exit(0));

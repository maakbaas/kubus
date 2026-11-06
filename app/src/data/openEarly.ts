import { openRepository } from ".";

// Imported first by main.tsx: the database worker starts (fetching its script and the SQLite wasm, opening and
// checking the database) while the rest of the app's modules are evaluated and React renders, instead of after
// the first render. The store then gets the same opening (openRepository opens once per page).
openRepository().catch(() => undefined); // a failure is shown by the store, which asks again

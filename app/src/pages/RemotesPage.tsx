import { CollectionsPage } from "./CollectionsPage";

/**
 * The remote collections (read from the server's remote connections, domain/sources.ts): listed,
 * added and edited here, never on the Collections page. In the side nav while the server has a
 * remote connection or remote collections exist (`useRemotesShown`).
 */
export function RemotesPage() {
  return <CollectionsPage remote />;
}

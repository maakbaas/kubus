// The HTTP API (/api/v1): every route is a thin translation onto one Repository method.
// Documented on the Help page (help/api.md).

import { json, Router } from "../../../shared/router";
import type { SqliteRepository } from "../data/sqlite/SqliteRepository";

export function createApi(repo: SqliteRepository): Router {
  return new Router().add("GET", "/api/v1/spaces", async () => json(200, await repo.listSpaces()));
}

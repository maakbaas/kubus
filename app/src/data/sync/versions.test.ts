// @vitest-environment node
// Devices and a server of different versions (shared/sync.ts SYNC_VERSION, docs/migrations.md):
// one that can't take the other's data is refused and nothing is lost; the rest sync, and a
// column one side doesn't know stays as it is on the other.
import { beforeEach, describe, expect, it } from "vitest";
import { device, FakeServer, settled } from "../../test/fakeServer";
import { SYNC_COMPATIBLE, SYNC_VERSION } from "../../../../shared/sync";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer().install();
});

const spaceNames = () => server.rows("spaces").map((r) => r.name);

describe("versions", () => {
  it("refuse a device too old for the server's data, keeping its changes until it is updated", async () => {
    const repo = await device();
    server.compatible = SYNC_VERSION + 1; // the server's data has changed in a way this version gets wrong
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await settled(repo);
    expect(repo.sync.status).toMatchObject({ state: "error", error: "Update the app" });
    expect(spaceNames()).toEqual([]);
    server.compatible = SYNC_VERSION; // this device updated
    await settled(repo);
    expect(repo.sync.status.state).toBe("idle");
    expect(spaceNames()).toEqual(["Work"]);
  });

  it("refuse a device whose data a server of an older version can't take", async () => {
    // Older than the oldest version that reads this device's data right.
    server.version = SYNC_COMPATIBLE - 1;
    const repo = await device();
    expect(repo.sync.status).toMatchObject({ state: "error", error: "Update the server" });
  });

  it("leave a column a device doesn't know as it is, sending a row and receiving it", async () => {
    const repo = await device();
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await settled(repo);
    // A newer device added a column this one doesn't have.
    const stored = server.tables.get("spaces")!.get("work")!;
    stored.row = { ...stored.row, color: "teal" };
    await repo.saveSpace({ id: "work", name: "Office", icon: null });
    await settled(repo);
    expect(server.rows("spaces")).toMatchObject([{ name: "Office", color: "teal" }]);
    const other = await device();
    expect((await other.listSpaces()).map((s) => s.name)).toContain("Office");
  });
});

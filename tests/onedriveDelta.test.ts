import { strict as assert } from "node:assert";
import { applyDelta, entitiesFromSlim, sameListing, slimOf, type DeltaCache, type SlimItem } from "../src/onedriveDelta";

const T = "2026-11-17T10:00:00Z";
const item = (id: string, name: string, parent: string | undefined, folder = false, extra: any = {}) =>
  ({ id, name, parentReference: parent ? { id: parent } : undefined, ...(folder ? { folder: {} } : {}), size: folder ? 0 : 5, eTag: `e-${id}`, fileSystemInfo: { lastModifiedDateTime: T }, ...extra });
const base = [item("root", "笔记", "approot", true), item("d1", "日记", "root", true), item("f1", "a.md", "d1"), item("d2", "深", "d1", true), item("f2", "b.md", "d2"), item("f3", "top.md", "root")];
const snapshot = (): DeltaCache => ({ v: 1, scope: "s", rootId: "root", deltaLink: "x", fullAt: 0, incrementalRuns: 0, items: base.map(x => slimOf(x as any)!) });
const keys = (items: Map<string, SlimItem> | undefined) => entitiesFromSlim(items!, "root")?.map(e => e.key).sort();

describe("Incremental OneDrive listing", () => {
  it("rebuilds nested paths from parent ids", () => {
    assert.deepEqual(keys(new Map(snapshot().items.map(i => [i.id, i]))), ["top.md", "日记/", "日记/a.md", "日记/深/", "日记/深/b.md"]);
  });
  it("moves every child when only the renamed folder is reported", () => {
    assert.deepEqual(keys(applyDelta(snapshot(), [item("d1", "日志", "root", true) as any])), ["top.md", "日志/", "日志/a.md", "日志/深/", "日志/深/b.md"]);
  });
  it("applies added, changed and deleted files", () => {
    const items = applyDelta(snapshot(), [item("f4", "new.md", "d2") as any, { id: "f3", deleted: {} } as any, item("f1", "a.md", "d1", false, { size: 9 }) as any])!;
    assert.deepEqual(keys(items), ["日记/", "日记/a.md", "日记/深/", "日记/深/b.md", "日记/深/new.md"]);
    assert.equal(entitiesFromSlim(items, "root")!.find(e => e.key === "日记/a.md")!.size, 9);
  });
  it("refuses to guess when a deleted folder leaves orphans behind", () => {
    assert.equal(keys(applyDelta(snapshot(), [{ id: "d2", deleted: {} } as any])), undefined);
  });
  it("accepts a folder deletion when its children are reported too", () => {
    assert.deepEqual(keys(applyDelta(snapshot(), [{ id: "f2", deleted: {} } as any, { id: "d2", deleted: {} } as any])), ["top.md", "日记/", "日记/a.md"]);
  });
  it("falls back on incomplete items or a deleted root", () => {
    assert.equal(applyDelta(snapshot(), [{ id: "f9", name: "x.md" } as any]), undefined);
    assert.equal(applyDelta(snapshot(), [item("f9", "x.md", undefined) as any]), undefined);
    assert.equal(applyDelta(snapshot(), [{ id: "root", deleted: {} } as any]), undefined);
  });
  it("rejects a file used as a parent folder", () => {
    assert.equal(keys(applyDelta(snapshot(), [item("f5", "bad.md", "f3") as any])), undefined);
  });
  it("compares listings independent of order", () => {
    const a = entitiesFromSlim(new Map(snapshot().items.map(i => [i.id, i])), "root")!;
    assert.ok(sameListing(a, [...a].reverse()));
    assert.ok(!sameListing(a, a.slice(1)));
  });
});

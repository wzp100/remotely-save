import { strict as assert } from "node:assert";
import { createHash, webcrypto } from "node:crypto";
import { Platform } from "obsidian";
import { DEFAULT_ONEDRIVE_CONFIG, FakeFsOnedrive, getAuthUrlAndVerifier } from "../src/fsOnedrive";
import { consumeOneDriveAuthSession, saveOneDriveAuthSession } from "../src/onedriveAuthSession";
import { changeOneDriveFolder, getSyncProfileID } from "../src/onedriveFolder";

describe("Mobile OneDrive authorization", () => {
  it("creates a valid PKCE challenge and an independent state value", async () => {
    const oldWindow = global.window;
    global.window = { crypto: webcrypto } as any;
    try {
      const result = await getAuthUrlAndVerifier("public-client-id", "https://login.microsoftonline.com/consumers/");
      const url = new URL(result.authUrl);
      assert.equal(url.pathname, "/consumers/oauth2/v2.0/authorize");
      assert.equal(url.searchParams.get("client_id"), "public-client-id");
      assert.equal(url.searchParams.get("redirect_uri"), "obsidian://remotely-save-cb-onedrive");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(result.verifier).digest("base64url"));
      assert.equal(url.searchParams.get("state"), result.state);
      assert.match(result.verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual((await getAuthUrlAndVerifier("public-client-id", "https://login.microsoftonline.com/consumers")).state, result.state);
      await assert.rejects(() => getAuthUrlAndVerifier("client", "http://example.invalid"), /HTTPS/);
    } finally {
      global.window = oldWindow;
    }
  });

  it("survives an app restart, rejects wrong states and consumes a session once", async () => {
    const values = new Map<string, unknown>();
    const db = { simpleKVForMiscTbl: {
      setItem: async (k: string, v: unknown) => values.set(k, v),
      getItem: async (k: string) => values.get(k),
      removeItem: async (k: string) => values.delete(k),
    } } as any;
    await saveOneDriveAuthSession(db, "vault-a", "private-verifier", "expected-state");
    await assert.rejects(() => consumeOneDriveAuthSession(db, "vault-a", "wrong-state"), /校验失败/);
    await assert.rejects(() => consumeOneDriveAuthSession(db, "vault-b", "expected-state"), /失效/);
    assert.equal(await consumeOneDriveAuthSession(db, "vault-a", "expected-state"), "private-verifier");
    await assert.rejects(() => consumeOneDriveAuthSession(db, "vault-a", "expected-state"), /失效/);
    await saveOneDriveAuthSession(db, "vault-a", "private-verifier", "expired-state");
    (values.get("vault-a-onedrive-pkce") as any).createdAt = Date.now() - 16 * 60 * 1000;
    await assert.rejects(() => consumeOneDriveAuthSession(db, "vault-a", "expired-state"), /失效/);
  });

  it("isolates history when choosing a shared folder without changing authorization", () => {
    const old = { ...DEFAULT_ONEDRIVE_CONFIG, clientID: "client", accessToken: "access", refreshToken: "refresh", remoteBaseDir: "old", deltaLink: "old-delta" };
    assert.equal(getSyncProfileID({ serviceType: "onedrive", onedrive: old } as any), "onedrive-default-1");
    assert.equal(changeOneDriveFolder(old, " old "), old);
    const next = changeOneDriveFolder(old, "笔记");
    assert.equal(next.remoteBaseDir, "笔记");
    assert.equal(next.refreshToken, "refresh");
    assert.equal(next.accessToken, "access");
    assert.equal(next.clientID, "client");
    assert.equal(next.deltaLink, "");
    assert.match(getSyncProfileID({ serviceType: "onedrive", onedrive: next } as any), /^onedrive-folder-/);
    assert.throws(() => changeOneDriveFolder(old, "../other"), /有效/);
    assert.equal(old.remoteBaseDir, "old");
  });
});

describe("Mobile OneDrive binary transfers", () => {
  const original = (Platform as any).isMobile;
  const fetchBefore = global.fetch;
  const client = () => new FakeFsOnedrive({ ...DEFAULT_ONEDRIVE_CONFIG, accessToken: "test", refreshToken: "test", accessTokenExpiresAtTime: Date.now() + 3600000 }, "vault", async () => {});
  beforeEach(() => { (Platform as any).isMobile = true; });
  afterEach(() => {
    (Platform as any).isMobile = original;
    global.fetch = fetchBefore;
    delete (global as any).__obsidianRequest;
    delete (global as any).__obsidianRequestUrl;
  });

  it("uploads exact binary bytes through the mobile native request API", async () => {
    let request: any;
    (global as any).__obsidianRequestUrl = async (args: any) => { request = args; return { status: 201, text: "", json: { id: "ok" } }; };
    const bytes = new Uint8Array([0, 255, 10, 128, 42]);
    await client()._putArrayBuffer("/file", bytes.buffer);
    assert.deepEqual([...new Uint8Array(request.body)], [...bytes]);
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.Authorization, "Bearer test");
  });

  it("uploads only the requested chunk without leaking an authorization header", async () => {
    let request: any;
    (global as any).__obsidianRequestUrl = async (args: any) => { request = args; return { status: 202, text: "", json: {} }; };
    await client()._putUint8ArrayByRange("https://upload.invalid", new Uint8Array([3, 4, 5, 6, 7]), 1, 4, 5);
    assert.deepEqual([...new Uint8Array(request.body)], [4, 5, 6]);
    assert.equal(request.headers["Content-Range"], "bytes 1-3/5");
    assert.equal(request.headers.Authorization, undefined);
  });

  it("downloads via the native API and rejects failed HTTP responses", async () => {
    (global as any).__obsidianRequest = async () => JSON.stringify({ "@microsoft.graph.downloadUrl": "https://download.invalid/file" });
    (global as any).__obsidianRequestUrl = async () => ({ status: 200, text: "", arrayBuffer: new Uint8Array([0, 255, 42]).buffer });
    global.fetch = async () => { throw new Error("mobile should not require browser CORS"); };
    assert.deepEqual([...new Uint8Array(await client()._readFileFromRoot("/file"))], [0, 255, 42]);
    (global as any).__obsidianRequestUrl = async () => ({ status: 403, text: "denied" });
    await assert.rejects(() => client()._putArrayBuffer("/file", new ArrayBuffer(1)), /HTTP 403/);
  });
});

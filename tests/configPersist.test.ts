// Local fork: paid integrations removed; free drivers and configuration retained.
import { strict as assert } from "assert";
import type { RemotelySavePluginSettings } from "../src/baseTypes";
import { messyConfigToNormal, normalConfigToMessy } from "../src/configPersist";
const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
    s3: {
        s3AccessKeyID: "acc",
    } as any,
    webdav: {
        address: "addr",
    } as any,
    dropbox: {
        username: "测试中文",
    } as any,
    onedrive: {
        username: "test 🍎 emoji",
    } as any,
    webdis: {
        address: "addr",
    } as any,
    password: "password",
    serviceType: "s3",
    currLogLevel: "info",
    ignorePaths: ["somefoldertoignore"],
    enableStatusBarInfo: true,
};
describe("Config Persist tests", () => {
    it("should encrypt go back and forth conrrectly", async () => {
        const k = DEFAULT_SETTINGS;
        const k2 = normalConfigToMessy(k);
        const k3 = messyConfigToNormal(k2);
        assert.deepEqual(k3, k);
    });
});

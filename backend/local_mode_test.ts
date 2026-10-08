import { assertEquals } from "jsr:@std/assert@^1.0.17";

// A fresh library must work without registering an account or retaining a cookie.
Deno.env.set("DATA_DIR", await Deno.makeTempDir({ prefix: "mytabs-local-" }));
Deno.env.set("MYTABS_PORT", "47779");
Deno.env.set("MYTABS_HOST", "0.0.0.0");
Deno.env.delete("MYTABS_LOCAL_MODE");
Deno.env.delete("MYTABS_DEMO_MODE");
const { main, closeServer } = await import("./main.ts");
const { db } = await import("./db.ts");
const { host } = await import("./util.ts");
const baseURL = "http://127.0.0.1:47779";

Deno.test({
    name: "fresh localhost library supports import, playback files and settings without accounts",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await main();
        try {
            assertEquals(host, "127.0.0.1");
            assertEquals(db.prepare("SELECT COUNT(*) AS count FROM user").get()?.count, 0);
            assertEquals(await (await fetch(`${baseURL}/api/is-finish-setup`)).json(), true);
            assertEquals((await (await fetch(`${baseURL}/api/app-config`)).json()).isLocalMode, true);

            const form = new FormData();
            form.set("file", new File([await Deno.readFile("extra/e2e-test.gp")], "local-test.gp"));
            form.set("title", "Local test");
            const imported = await fetch(`${baseURL}/api/new-tab`, { method: "POST", body: form, headers: { Origin: baseURL } });
            assertEquals(imported.status, 200);
            const { id } = await imported.json();
            const config = await (await fetch(`${baseURL}/api/tab/${id}`)).json();
            assertEquals(config.ok, true);
            assertEquals(config.tab.public, false);
            const file = await fetch(`${baseURL}/api/tab/${id}/file`);
            assertEquals(file.status, 200);
            assertEquals((await file.arrayBuffer()).byteLength > 0, true);
            assertEquals((await (await fetch(`${baseURL}/api/tabs`)).json()).tabs.length, 2);

            const settings = { preferredInstrument: "guitar", scale: 0.85 };
            const saved = await fetch(`${baseURL}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
            assertEquals(saved.status, 200);
            await saved.arrayBuffer();
            assertEquals((await (await fetch(`${baseURL}/api/settings`)).json()).setting, settings);
            assertEquals(db.prepare("SELECT COUNT(*) AS count FROM user").get()?.count, 0);

            const foreign = await fetch(`${baseURL}/api/settings`, { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: "{}" });
            assertEquals(foreign.status, 403);
            await foreign.arrayBuffer();
            const register = await fetch(`${baseURL}/register`, { method: "POST" });
            assertEquals(register.status, 404);
            await register.arrayBuffer();
        } finally {
            closeServer();
        }
    },
});

// Import a local Guitar Pro / MusicXML collection without a login in local mode.
// Account mode optionally uses MYTABS_EMAIL and MYTABS_PASSWORD.
// Run after deno task setup. alphaTab's CLI parser uses its official Node runtime.
// Usage: node extra/import-pool.mjs <folder> [report.json] [http://127.0.0.1:47777]
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as alphaTab from "../frontend/node_modules/@coderline/alphatab/dist/alphaTab.mjs";
const supportedFormatList = ["gp", "gpx", "gp3", "gp4", "gp5", "musicxml", "capx"];

const folder = process.argv[2];
if (!folder) {
    throw new Error("Bir Guitar Pro / MusicXML klasörü belirtin.");
}
const reportPath = process.argv[3] ?? "import-report.json";
const baseURL = new URL(process.argv[4] ?? "http://127.0.0.1:47777");
if (!["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)) {
    throw new Error("Bu kişisel içe aktarıcı yalnızca yerel sunucuya bağlanır.");
}
// Reserve the report before modifying the library; preserve earlier reports.
const reportFile = await fs.open(reportPath, "wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error("Rapor dosyası zaten var. Yeni bir rapor adı belirtin.");
    throw error;
});

const modeResponse = await fetch(new URL("/api/app-config", baseURL));
const localMode = modeResponse.ok && (await modeResponse.json()).isLocalMode === true;
const headers = { Origin: baseURL.origin };
if (!localMode) {
    const email = process.env.MYTABS_EMAIL;
    const password = process.env.MYTABS_PASSWORD;
    if (!email || !password) {
        throw new Error("Hesaplı mod için MYTABS_EMAIL ve MYTABS_PASSWORD ortam değişkenlerini ayarlayın.");
    }
    const login = await fetch(new URL("/api/auth/sign-in/email", baseURL), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseURL.origin },
        body: JSON.stringify({ email, password }),
    });
    if (!login.ok) {
        throw new Error(`Yerel hesaba giriş başarısız (${login.status}).`);
    }
    headers.Cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    await login.arrayBuffer();
    if (!headers.Cookie) {
        throw new Error("Oturum çerezi alınamadı.");
    }
}
const listResponse = await fetch(new URL("/api/tabs", baseURL), { headers });
const existing = await listResponse.json();
if (!listResponse.ok || existing.ok === false || !Array.isArray(existing.tabs)) {
    throw new Error("Kitaplık okunamadı.");
}

async function hash(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const knownHashes = new Set();
for (const tab of existing.tabs) {
    const fileURL = new URL(`/api/tab/${tab.id}/file`, baseURL);
    const fileResponse = await fetch(fileURL, { headers });
    if (!fileResponse.ok) {
        throw new Error(`Mevcut eser ${tab.id} için dosya alınamadı.`);
    }
    knownHashes.add(await hash(new Uint8Array(await fileResponse.arrayBuffer())));
}

const files = [];
async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(filename);
        else if (entry.isFile() && supportedFormatList.includes(path.extname(filename).slice(1).toLowerCase())) files.push(filename);
    }
}
await collect(path.resolve(folder));
files.sort();
const entries = [];
for (const filename of files) {
    const file = path.relative(path.resolve(folder), filename);
    try {
        const bytes = new Uint8Array(await fs.readFile(filename));
        const sha256 = await hash(bytes);
        if (knownHashes.has(sha256)) {
            entries.push({ file, status: "skipped", sha256 });
            continue;
        }
        const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
        const stem = path.basename(filename, path.extname(filename));
        const separator = stem.indexOf(" - ");
        const title = score.title.trim() || (separator >= 0 ? stem.slice(separator + 3) : stem);
        const artist = score.artist.trim() || (separator >= 0 ? stem.slice(0, separator) : "Bilinmeyen sanatçı");
        const form = new FormData();
        form.append("file", new File([bytes], path.basename(filename)));
        form.append("title", title);
        form.append("artist", artist);
        const response = await fetch(new URL("/api/new-tab", baseURL), { method: "POST", headers, body: form });
        // A successful HTTP response may precede a lost/malformed JSON body.
        // Don't submit identical bytes again in this run; the next run checks the API afresh.
        if (response.ok) knownHashes.add(sha256);
        const result = await response.json();
        if (!response.ok || result.ok === false || !result.id) {
            throw new Error(result.msg ?? "Dosya yüklenemedi.");
        }
        knownHashes.add(sha256);
        entries.push({ file, status: "imported", sha256, id: String(result.id), title, artist, bars: score.masterBars.length, tracks: score.tracks.map((track) => track.name) });
        console.log(`${entries.length}/${files.length}: ${artist} — ${title}`);
    } catch (error) {
        entries.push({ file, status: "failed", error: error instanceof Error ? error.message : String(error) });
        console.error(`Eklenemedi: ${file}`);
    }
}
const summary = {
    checkedAt: new Date().toISOString(),
    supportedFiles: files.length,
    imported: entries.filter((entry) => entry.status === "imported").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    entries,
};
await reportFile.writeFile(JSON.stringify(summary, null, 2) + "\n");
await reportFile.close();
console.log(JSON.stringify({ imported: summary.imported, skipped: summary.skipped, failed: summary.failed, report: reportPath }));
if (summary.failed > 0) {
    process.exitCode = 1;
}

<script>
import { defineComponent } from "vue";
import Vue3Dropzone from "@jaxtheprime/vue3-dropzone";
import "@jaxtheprime/vue3-dropzone/dist/style.css";
import { notify } from "@kyvg/vue3-notification";
import { baseURL } from "../app.js";
import { supportedFormatCommaString } from "../../../backend/common.js";

const alphaTab = await import("@coderline/alphatab");

export default defineComponent({
    components: { Vue3Dropzone },
    data() {
        return {
            files: [],
            supportedFormatCommaString,
            isUploading: false,
            fileResults: [],
            uploadComplete: false,
        };
    },
    computed: {
        uploadedCount() {
            return this.fileResults.filter((file) => file.status === "success").length;
        },
        failedCount() {
            return this.fileResults.filter((file) => file.status === "error").length;
        },
        finishedCount() {
            return this.uploadedCount + this.failedCount;
        },
    },
    methods: {
        addFiles(fileList) {
            if (this.isUploading) return;
            const existingKeys = new Set(
                this.files.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`),
            );

            for (const file of fileList) {
                const key = `${file.name}:${file.size}:${file.lastModified}`;
                if (!existingKeys.has(key)) {
                    this.files.push({ file, name: file.name });
                    existingKeys.add(key);
                }
            }

            this.uploadComplete = false;
            this.fileResults = [];
        },
        onFolderSelected(event) {
            this.addFiles(Array.from(event.target.files || []));
            event.target.value = "";
        },
        fileTitle(file) {
            return file.name.replace(/\.[^.]+$/, "").trim() || "İsimsiz eser";
        },
        isSupportedFile(file) {
            const extension = file.name.split(".").pop()?.toLowerCase();
            const supportedExtensions = supportedFormatCommaString
                .split(",")
                .map((format) => format.trim().replace(/^\./, "").toLowerCase());
            return supportedExtensions.includes(extension);
        },
        async uploadOne(entry, index) {
            const file = entry.file;
            const result = this.fileResults[index];

            try {
                result.status = "processing";
                if (!this.isSupportedFile(file)) {
                    throw new Error("Desteklenmeyen dosya biçimi");
                }

                const data = await file.arrayBuffer();
                const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
                    new Uint8Array(data),
                    new alphaTab.Settings(),
                );

                const title = (score.title || "").trim() || this.fileTitle(file);
                const artist = (score.artist || "").trim() || "Bilinmeyen sanatçı";
                const formData = new FormData();
                formData.append("file", file);
                formData.append("title", title);
                formData.append("artist", artist);

                const response = await fetch(baseURL + "/api/new-tab", {
                    method: "POST",
                    credentials: "include",
                    body: formData,
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => null);
                    throw new Error(errorData?.msg || errorData?.message || "Yükleme başarısız oldu");
                }

                const responseData = await response.json().catch(() => ({}));
                if (responseData.ok === false || !responseData.id) throw new Error(responseData.msg || "Sunucu geçerli bir eser kaydı döndürmedi.");
                result.status = "success";
                result.message = `${artist} — ${title}`;
                result.id = responseData?.id || null;
            } catch (error) {
                result.status = "error";
                result.message = error.message || "Dosya işlenemedi";
            }
        },
        async upload() {
            if (this.isUploading) return;
            if (this.files.length === 0) {
                notify({ text: "Önce en az bir dosya seçin.", type: "error" });
                return;
            }

            this.isUploading = true;
            this.uploadComplete = false;
            this.fileResults = this.files.map(({ file }) => ({
                name: file.name,
                status: "pending",
                message: "Bekliyor",
                id: null,
            }));

            // Sequential uploads keep the personal library import bounded and predictable.
            for (let index = 0; index < this.files.length; index += 1) {
                await this.uploadOne(this.files[index], index);
            }

            this.files = this.files.filter((_, index) => this.fileResults[index].status !== "success");
            this.isUploading = false;
            this.uploadComplete = true;
            notify({
                text: `${this.uploadedCount} dosya eklendi${this.failedCount ? `, ${this.failedCount} dosya eklenemedi` : ""}.`,
                type: this.failedCount ? "warn" : "success",
            });
        },
        dropzoneError(error) {
            notify({ text: error.type || "Dosya seçimi sırasında hata oluştu.", type: "error" });
        },
        async createEmpty(type) {
            if (this.isUploading) return;
            this.isUploading = true;
            try {
                const response = await fetch(baseURL + `/api/new-tab/template/${type}`, {
                    method: "POST",
                    credentials: "include",
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => null);
                    throw new Error(errorData?.msg || errorData?.message || "Şablon oluşturulamadı");
                }

                const data = await response.json();
                notify({ text: "Boş eser oluşturuldu.", type: "success" });
                if (data.id) this.$router.push(`/tab/${data.id}`);
            } catch (error) {
                notify({ text: error.message || "Beklenmeyen bir hata oluştu.", type: "error" });
            } finally {
                this.isUploading = false;
            }
        },
    },
});
</script>

<template>
    <div class="container my-container">
        <div class="display-6 mb-4 mt-5">Şarkı kitaplığına eser ekle</div>
        <p class="text-muted">Guitar Pro veya MusicXML dosyalarını tek tek ya da bir klasörden topluca içe aktarın.</p>

        <fieldset :disabled="isUploading" :inert="isUploading" class="border-0 p-0 m-0">
            <Vue3Dropzone
                v-model="files"
                :maxFileSize="500"
                :multiple="true"
                :maxFiles="500"
                :disabled="isUploading"
                @error="dropzoneError"
            >
                <template #title>Dosyaları buraya bırakın</template>
                <template #description>Desteklenen biçimler: {{ supportedFormatCommaString }}</template>
            </Vue3Dropzone>
        </fieldset>

        <div class="d-flex flex-wrap align-items-center gap-3 mt-3">
            <label class="btn btn-outline-secondary mb-0" for="folder-import">Klasörden seç</label>
            <input
                id="folder-import"
                class="visually-hidden"
                type="file"
                multiple
                webkitdirectory
                directory
                :disabled="isUploading"
                @change="onFolderSelected"
            />
            <span class="text-muted small">{{ files.length }} dosya seçildi</span>
        </div>

        <button
            @click="upload"
            class="btn btn-primary w-100 mt-4"
            :disabled="isUploading || files.length === 0"
        >
            {{ isUploading ? `İçe aktarılıyor (${finishedCount}/${files.length})…` : "Kitaplığa ekle" }}
        </button>

        <div v-if="isUploading" class="progress mt-3" role="progressbar" :aria-valuenow="finishedCount" :aria-valuemax="files.length">
            <div class="progress-bar" :style="{ width: `${(finishedCount / files.length) * 100}%` }"></div>
        </div>

        <section v-if="fileResults.length" class="mt-4" aria-live="polite">
            <h2 class="h5">{{ uploadComplete ? "İçe aktarma özeti" : "Dosya durumu" }}</h2>
            <p v-if="uploadComplete" class="mb-2">
                {{ uploadedCount }} eklendi<span v-if="failedCount"> · {{ failedCount }} başarısız</span>
            </p>
            <ul class="list-group">
                <li v-for="(result, index) in fileResults" :key="`${result.name}-${index}`" class="list-group-item d-flex justify-content-between gap-3">
                    <span class="text-break">
                        {{ result.name }}
                        <small v-if="result.status === 'success'" class="d-block text-muted">{{ result.message }}</small>
                    </span>
                    <span :class="{
                        'text-success': result.status === 'success',
                        'text-danger': result.status === 'error',
                        'text-muted': result.status === 'pending' || result.status === 'processing',
                    }">
                        {{ result.status === "success" ? "Eklendi" : result.status === "error" ? result.message : result.status === "processing" ? "İşleniyor…" : "Bekliyor" }}
                    </span>
                </li>
            </ul>
            <button
                v-if="uploadComplete && uploadedCount"
                class="btn btn-link px-0 mt-2"
                @click="$router.push('/')"
            >Kitaplığı aç</button>
        </section>

        <ul v-if="!isUploading" class="mt-4">
            <li><a href="#" @click.prevent='createEmpty("bass")' class="me-3">Boş bas gitar eseri oluştur</a></li>
            <li><a href="#" @click.prevent='createEmpty("guitar")'>Boş gitar eseri oluştur</a></li>
        </ul>

        <h4 class="mt-5">Tab kaynakları</h4>
        <ul class="free-resources">
            <li><a href="https://github.com/AlexMi-Ha/GuitarTabs" target="_blank" rel="noopener">GuitarTabs koleksiyonu</a><br />Bu forkta içe aktarması denenen 82 Guitar Pro dosyası</li>
            <li><a href="https://www.ultimate-guitar.com/" target="_blank" rel="noopener">Ultimate Guitar</a><br />Akorlar ve Guitar Pro dosyaları</li>
            <li><a href="https://www.911tabs.com/" target="_blank" rel="noopener">911Tabs</a><br />Tab arama motoru</li>
            <li>
                <a href="https://musescore.com/sheetmusic?instrument=72%2C73&recording_type=free-download" target="_blank" rel="noopener">MuseScore</a><br />MusicXML notaları
            </li>
            <li><a href="https://gprotab.net/" target="_blank" rel="noopener">GProTab</a><br />Ücretsiz Guitar Pro tabları</li>
        </ul>
    </div>
</template>

<style lang="scss">
.img-details {
    opacity: 1 !important;
    visibility: visible !important;
}

.free-resources li {
    margin-bottom: 15px;
}
</style>

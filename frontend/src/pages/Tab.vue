<script>
import {
    ActionBuffer,
    baseURL,
    checkFetch,
    connectSocketIO,
    convertAlphaTexSyncPoint,
    findPreferredTrack,
    generalError,
    getInstrumentName,
    getSetting,
    releaseWakeLock,
    requestWakeLock,
} from "../app.js";
import { defineComponent } from "vue";
import { BDropdown, BDropdownDivider, BDropdownItem } from "bootstrap-vue-next";
import { notify } from "@kyvg/vue3-notification";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { isLoggedIn } from "../auth-client.js";
import { getKeySignature } from "../util.ts";
import { countIn } from "../count-in.ts";
import { setupSelection } from "../selection.ts";

const alphaTab = await import("@coderline/alphatab");
const { ScrollMode, StaveProfile } = alphaTab;

const speedActionBuffer = new ActionBuffer(1000);
const syncOffsetYoutubeActionBuffer = new ActionBuffer(200);
const syncOffsetAudioActionBuffer = new ActionBuffer(200);
let youtubeApiLoadingPromise;

function loadYoutubeIframeApi() {
    if (window.YT?.Player) {
        return Promise.resolve();
    }
    if (youtubeApiLoadingPromise) {
        return youtubeApiLoadingPromise;
    }

    youtubeApiLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        let settled = false;
        const previousReady = window.onYouTubeIframeAPIReady;
        const timeout = window.setTimeout(() => finish(new Error("YouTube API zamanında yüklenemedi.")), 20000);
        const finish = (error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            if (window.onYouTubeIframeAPIReady === readyCallback) {
                window.onYouTubeIframeAPIReady = previousReady;
            }
            youtubeApiLoadingPromise = undefined;
            if (error) reject(error);
            else resolve();
        };
        const readyCallback = () => {
            try {
                previousReady?.();
            } finally {
                finish();
            }
        };

        window.onYouTubeIframeAPIReady = readyCallback;
        script.src = "https://www.youtube.com/iframe_api";
        script.onerror = () => finish(new Error("YouTube API yüklenemedi."));
        document.head.appendChild(script);
    });

    return youtubeApiLoadingPromise;
}

export default defineComponent({
    /**
     * @type {SocketIOClient.Socket}
     */
    socket: null,

    /**
     * @type {alphaTab.AlphaTabApi}
     */
    api: null,

    audioHandler: null,

    alphaTabYoutubeHandler: null,

    youtubePlayer: null,

    components: { FontAwesomeIcon, BDropdownDivider, BDropdownItem, BDropdown },
    emits: ["setFixedHeader"],
    data() {
        return {
            isLoggedIn: false,
            title: "",
            artist: "",
            youtube: {},
            tabID: -1,
            tracks: [],
            showTrackList: false,
            showAudioList: false,
            tab: {},
            playing: false,
            enableCountIn: false,
            enableMetronome: false,
            isCountingIn: false,
            seekDownBeat: null,
            enableBackingTrack: true,
            isLooping: false,
            speed: 100,
            ready: false,
            selectedTrack: 0,
            soloTrackID: -1,
            muteTrackList: {},
            currentAudio: "synth",
            youtubePlayerReady: false,
            youtubePlayerPromise: null,
            youtubePlayerCancel: null,
            youtubeVideoID: null,
            youtubeRequestID: 0,
            youtubePlayerLifecycle: 0,
            youtubeError: null,
            youtubeWarningTimeout: undefined,
            youtubePlaybackInterval: undefined,
            youtubeList: [],
            audioList: [],
            audio: {},
            scrollMode: ScrollMode.Continuous,
            keySignature: "",
            playbackRange: null,
            savedPlaybackRange: null,
            playbackRangeRestoreTimer: undefined,
            selectionController: null,

            keyEvents: (e) => {
                // Do not handle these tagName, because the only input is sync point, it is weird when play space to test the sync point
                // It will type a space in the input instead of playing the music
                // element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable

                if (e.code === "Space") {
                    e.preventDefault();
                    this.playPause();
                } else if (e.code === "ArrowLeft") {
                    e.preventDefault();
                    this.moveToBar(-1);
                } else if (e.code === "ArrowRight") {
                    e.preventDefault();
                    this.moveToBar(1);
                } else if (e.code === "ArrowUp") {
                    e.preventDefault();
                    const result = this.playFromHighlightedRange();

                    // Also act as the key S if not highlighted
                    if (!result) {
                        this.playFromFirstBarContainingNotes(-2);
                    }
                } else if (e.code === "KeyS") {
                    e.preventDefault();
                    this.playFromFirstBarContainingNotes(-2);
                }
            },
            setting: {},
            simpleSyncSecond: -1,
            toolbarAutoHide: false,
            isInitializingAudio: false, // Flag to prevent sync point clearing during audio init
            soundFontBank: "generaluser-gs",
            soundFontFallbackTried: false,
            soundFontLoading: true,
            soundFontFailed: false,
            soundFontProgress: 0,
            soundFontLoaded: false,
            synthPlayerReady: false,
            synthReady: false,
            handledSoundFontErrors: new WeakSet(),
        };
    },
    computed: {
        animatedCursor() {
            return this.setting.cursor === "animated" || this.setting.scrollMode === ScrollMode.Smooth;
        },

        syncMethod() {
            if (this.currentAudio.startsWith("youtube-")) {
                return this.youtube.syncMethod;
            } else if (this.currentAudio.startsWith("audio-")) {
                return this.audio.syncMethod;
            } else {
                return undefined;
            }
        },

        soundFontLabel() {
            return this.soundFontBank === "sonivox" ? "Sonivox" : "GeneralUser GS";
        },

        youtubePlaybackFailed() {
            return !!this.youtubeError && this.currentAudio === `youtube-${this.youtubeError.videoID}`;
        },

        youtubeLoading() {
            return this.currentAudio.startsWith("youtube-") &&
                (this.isInitializingAudio || !this.youtubePlayerReady) && !this.youtubePlaybackFailed;
        },

        youtubeLocalhostHref() {
            if (window.location.hostname !== "127.0.0.1") return null;
            const localUrl = new URL(window.location.href);
            localUrl.hostname = "localhost";
            localUrl.searchParams.set("audio", this.currentAudio);
            localUrl.searchParams.set("track", String(this.selectedTrack));
            return localUrl.href;
        },
    },

    watch: {
        async simpleSyncSecond(newVal, oldVal) {
            if (!this.api) {
                return;
            }

            // Skip if we're in the middle of initializing audio to prevent clearing sync points
            if (this.isInitializingAudio) {
                console.log("Skipping simpleSyncSecond watcher during audio initialization");
                return;
            }

            let obj;

            if (this.currentAudio.startsWith("youtube-")) {
                if (!this.youtube) {
                    return;
                }
                obj = this.youtube;
            } else if (this.currentAudio.startsWith("audio-")) {
                if (!this.audio) {
                    return;
                }
                obj = this.audio;
            }

            this.pause();

            obj.simpleSync = this.simpleSyncSecond * 1000;

            // Bug? If change to EnabledExternalMedia, andthis.api.updateSettings(), this sync point can not be applied correctly.
            // So it must change to EnabledSynthesizer first, then change to EnabledExternalMedia
            this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
            this.api.updateSettings();

            this.simpleSync(obj.simpleSync);

            // Restore
            this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
            this.api.updateSettings();

            // Save
            if (this.currentAudio.startsWith("youtube-")) {
                this.api.player.output.handler = this.alphaTabYoutubeHandler;
                syncOffsetYoutubeActionBuffer.run(() => {
                    if (oldVal !== -1) {
                        this.saveYoutube();
                    }
                });
            } else {
                this.api.player.output.handler = this.audioHandler;
                syncOffsetAudioActionBuffer.run(() => {
                    if (oldVal !== -1) {
                        this.saveAudio();
                    }
                });
            }
        },

        "youtube.simpleSync"() {
            if (!this.api || !this.youtube) {
                return;
            }
            this.simpleSyncSecond = parseFloat((this.youtube.simpleSync / 1000).toFixed(2));
        },

        "audio.simpleSync"() {
            if (!this.api || !this.audio) {
                return;
            }
            this.simpleSyncSecond = parseFloat((this.audio.simpleSync / 1000).toFixed(2));
        },

        playing() {
            if (!this.api) {
                return;
            }

            if (this.playing) {
                this.api.settings.player.scrollMode = this.scrollMode;
                this.api.updateSettings();

                // alphaTab only supports count-in natively for the synthesizer player.
                // For external audio sources, play a custom Web Audio count-in first.
                if (this.enableCountIn && this.needsCustomCountIn()) {
                    this.startExternalCountIn();
                } else {
                    this.api.play();
                }

                requestWakeLock();
            } else {
                countIn.cancel();
                this.isCountingIn = false;
                this.api.pause();
                releaseWakeLock();
            }

            // Hide the cursor when playing
            if (this.setting.cursor === "invisible" || this.setting.cursor === "bar") {
                const cursor = document.querySelector(".at-cursor-beat");
                if (cursor) {
                    if (this.playing) {
                        console.log("Hide cursor");
                        cursor.classList.add("invisible");
                    } else {
                        console.log("Show cursor");
                        cursor.classList.remove("invisible");
                    }
                }
            }

            // Show the bar cursor if enabled
            if (this.setting.cursor === "bar") {
                const barCursor = document.querySelector(".at-cursor-bar");
                if (barCursor) {
                    barCursor.classList.add("enable");
                }
            }
        },

        enableCountIn() {
            if (!this.api) {
                return;
            }
            this.applyCountInVolume();
            this.setConfig("enableCountIn", this.enableCountIn);
        },

        enableMetronome() {
            if (!this.api) {
                return;
            }
            if (this.enableMetronome) {
                this.api.metronomeVolume = 1;
            } else {
                this.api.metronomeVolume = 0;
            }
            this.setConfig("enableMetronome", this.enableMetronome);
        },

        isLooping() {
            if (!this.api) {
                return;
            }
            this.api.isLooping = this.isLooping;
            this.setConfig("isLooping", this.isLooping);
        },

        speed(newVal) {
            if (!this.api) {
                return;
            }
            console.log("Speed changed to:", newVal);

            let speed = newVal;

            if (typeof speed !== "number" || isNaN(speed)) {
                speed = 100;
            } else if (speed < 20) {
                speed = 20;
            } else if (speed > 1000) {
                speed = 1000;
            }

            // Rate limit the speed change action
            speedActionBuffer.run(() => {
                this.api.playbackSpeed = parseFloat((speed / 100).toFixed(2));
                this.setConfig("speed", speed);
            });
        },

        // Switch Audio Source
        async currentAudio() {
            console.log("Switching audio to:", this.currentAudio);

            this.youtubeRequestID++;
            this.isInitializingAudio = false;
            this.youtubeError = null;
            this.clearYoutubePlaybackInterval();
            if (this.currentAudio.startsWith("youtube-")) {
                this.youtubeVideoID = this.currentAudio.substring(8);
            } else {
                this.youtubeVideoID = null;
                this.youtubePlayer?.pauseVideo?.();
                window.clearTimeout(this.youtubeWarningTimeout);
                this.youtubeWarningTimeout = undefined;
            }

            if (!this.api) {
                return;
            }

            // alphaTab's native count-in only works on the synthesizer player, so reset
            // its volume here to avoid a silent count-in running on external media.
            this.applyCountInVolume();

            // Save the playback range before switching audio source.
            const range = this.api.playbackRange;
            if (range) {
                this.savedPlaybackRange = { startTick: range.startTick, endTick: range.endTick };
            }

            this.api.player.masterVolume = 1;

            if (this.currentAudio === "synth") {
                await this.initSynth();
            } else if (this.currentAudio === "backingTrack") {
                this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledBackingTrack;
                this.api.updateSettings();
                this.pause();
            } else if (this.currentAudio.startsWith("youtube-")) {
                const videoID = this.currentAudio.substring(8);
                await this.initYoutube(videoID);
            } else if (this.currentAudio.startsWith("audio-")) {
                const filename = this.currentAudio.substring(6);
                await this.initAudio(filename);
            } else if (this.currentAudio === "none") {
                // Workaround: alphaTab.PlayerMode.Disabled is not working, so just mute the volume
                this.api.player.masterVolume = 0;
                this.pause();
            } else {
                // Unknown audio source, fallback to synth
                await this.initSynth();
                notify({
                    type: "error",
                    title: "Error",
                    text: "Unknown audio source, fallback to synth.",
                });
                return;
            }

            this.setConfig("audio", this.currentAudio);
        },
    },

    // Mounted
    async mounted() {
        this.isLoggedIn = await isLoggedIn();
        this.setting = getSetting();
        this.toolbarHidden = this.setting.toolbarAutoHide;
        this.tabID = this.$route.params.id;
        const urlParams = new URLSearchParams(window.location.search);

        try {
            // Override trackID if provided in URL
            const trackParam = urlParams.get("track");
            if (trackParam) {
                const id = parseInt(trackParam);
                if (!isNaN(id)) {
                    this.setConfig("trackID", id);
                }
            }

            // Override audio source if provided in URL
            const audioParam = urlParams.get("audio");
            if (audioParam) {
                this.setConfig("audio", audioParam);
            }

            const trackID = this.getConfig("trackID", -1);

            // Load the AlphaTab
            await this.load(trackID);

            window.addEventListener("keydown", this.keyEvents);

            // Close open lists when clicking outside
            this._onDocumentClick = (e) => {
                try {
                    // Track list
                    if (this.showTrackList) {
                        const sel = this.$refs.trackSelector;
                        const list = this.$refs.trackList;
                        if (!sel.contains(e.target) && !list.contains(e.target)) {
                            this.showTrackList = false;
                        }
                    }

                    // Audio list
                    if (this.showAudioList) {
                        const sel = this.$refs.audioSelector;
                        const list = this.$refs.audioList;
                        if (!sel.contains(e.target) && !list.contains(e.target)) {
                            this.showAudioList = false;
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
            };
            window.addEventListener("click", this._onDocumentClick);
        } catch (e) {
            notify({
                type: "error",
                title: "Error",
                text: e.message,
            });
        }

        await this.initSocketIO();

        console.log("Mounted");
    },
    beforeUnmount() {
        console.log("Before unmount");
        this.destroyContainer();
        window.removeEventListener("keydown", this.keyEvents);

        if (this._onDocumentClick) {
            window.removeEventListener("click", this._onDocumentClick);
            this._onDocumentClick = undefined;
        }

        this.destroyYoutubePlayer();
        this.socket.disconnect();
    },
    methods: {
        async load(trackID) {
            if (this.api) {
                this.destroyContainer();
            }

            const res = await fetch(baseURL + `/api/tab/${this.tabID}`, {
                credentials: "include",
            });

            try {
                await checkFetch(res);
            } catch (e) {
                if (e.message === "Not logged in") {
                    this.$router.push("/login");
                    return;
                } else {
                    throw e;
                }
            }

            const data = await res.json();
            if (data.tab) {
                this.tab = data.tab;
                this.youtubeList = data.youtubeList;
                this.audioList = data.audioList;
            }

            const tempToken = await this.getTempToken();

            // Requested trackID may be invalid, so we need to get the actual trackID used
            trackID = await this.initContainer(tempToken, trackID);

            this.setConfig("trackID", trackID);
        },

        countIn() {
            this.enableCountIn = !this.enableCountIn;
        },

        metronome() {
            this.enableMetronome = !this.enableMetronome;
        },

        loop() {
            this.isLooping = !this.isLooping;
        },

        playPause() {
            if (!this.api || !this.canStartPlayback()) {
                return;
            }

            this.playing = !this.playing;
        },

        play() {
            if (!this.api || !this.canStartPlayback()) {
                return;
            }
            this.playing = true;
        },

        pause() {
            if (!this.api || !this.ready) {
                return;
            }
            this.playing = false;
        },

        /**
         * Start (or restart) playback.
         *
         * The `playing` watcher only reacts to state changes, so restarting while
         * already playing (e.g. the "Restart" button) would never re-run the
         * count-in. When count-in is enabled, stop first and count in again.
         */
        startPlayback() {
            if (!this.api || !this.canStartPlayback()) {
                return;
            }

            if (this.playing && this.enableCountIn) {
                this.api.pause();

                if (this.needsCustomCountIn()) {
                    this.startExternalCountIn();
                } else {
                    // alphaTab runs its native count-in when play() is called from a paused state
                    this.api.play();
                }
            } else {
                this.play();
            }
        },

        canStartPlayback() {
            return this.ready && (this.currentAudio !== "synth" || this.synthReady) && !this.youtubePlaybackFailed && !this.youtubeLoading;
        },

        syncSynthReady() {
            this.synthReady = this.soundFontLoaded && this.synthPlayerReady;
        },

        soundFontURL(bank) {
            return bank === "sonivox" ? "/soundfont/sonivox.sf2" : "/soundfont/generaluser-gs.sf2";
        },

        retrySoundFont() {
            if (!this.api || this.soundFontLoading) {
                return;
            }

            this.soundFontFallbackTried = false;
            this.soundFontBank = this.setting.soundFont;
            this.soundFontFailed = false;
            this.soundFontLoading = true;
            this.soundFontLoaded = false;
            this.soundFontProgress = 0;
            this.synthReady = false;
            this.api.loadSoundFontFromUrl(this.soundFontURL(this.soundFontBank), false);
        },

        handleSoundFontLoadFailure(error) {
            this.handledSoundFontErrors.add(error);
            this.soundFontLoading = false;
            this.soundFontLoaded = false;
            this.synthReady = false;

            if (this.soundFontBank === "generaluser-gs" && !this.soundFontFallbackTried) {
                this.soundFontFallbackTried = true;
                this.soundFontBank = "sonivox";
                this.soundFontLoading = true;
                this.soundFontProgress = 0;
                notify({
                    type: "error",
                    title: "Ses bankası yüklenemedi",
                    text: "GeneralUser GS yüklenemedi; eski ses bankasına geçiliyor.",
                });
                this.api.loadSoundFontFromUrl(this.soundFontURL("sonivox"), false);
                return;
            }

            this.soundFontFailed = true;
            notify({
                type: "error",
                title: "Ses bankası yüklenemedi",
                text: `${this.soundFontLabel} yüklenemedi. Yeniden deneyin.`,
            });
        },

        /**
         * Play from the beginning of highlighted range
         * Do nothing if no bar is highlighted
         */
        playFromHighlightedRange() {
            if (!this.api || !this.ready) {
                return;
            }

            const playbackRange = this.api.playbackRange;
            if (!playbackRange) {
                return false;
            }

            this.api.tickPosition = playbackRange.startTick;
            this.startPlayback();
            return true;
        },

        /**
         * A stable identifier for a beat, used to tell a plain click on a beat
         * from a drag-selection. Different model instances can represent the
         * same logical beat (e.g. multiple voices), so compare bar + beat + tick.
         * @param beat The beat from a beatMouseDown/beatMouseUp event
         * @returns {string | null}
         */
        getBeatKey(beat) {
            const modelBeat = beat ? beat.beat ?? beat : null;
            const bar = modelBeat && modelBeat.voice ? modelBeat.voice.bar : null;
            if (!bar) {
                return null;
            }
            return `${bar.index}:${modelBeat.index}:${modelBeat.absolutePlaybackStart}`;
        },

        /**
         * Whether the current audio source needs our custom Web Audio count-in.
         * alphaTab only implements count-in natively for the synthesizer player,
         * for external media the count-in is silent and playback starts instantly.
         * @returns {boolean}
         */
        needsCustomCountIn() {
            return (
                this.currentAudio.startsWith("audio-") ||
                this.currentAudio.startsWith("youtube-") ||
                this.currentAudio === "backingTrack"
            );
        },

        /**
         * Apply the alphaTab count-in volume according to the current settings.
         * Native count-in is only enabled on the synthesizer player, so external
         * media doesn't trigger alphaTab's silent count-in.
         */
        applyCountInVolume() {
            if (!this.api) {
                return;
            }
            this.api.countInVolume = this.enableCountIn && this.currentAudio === "synth" ? 1 : 0;
        },

        /**
         * Get the tempo and time signature at the current playback position,
         * adjusted for the playback speed, to time the count-in beats.
         * @returns {{ bpm: number, beats: number }}
         */
        getCountInInfo() {
            const masterBars = this.api.score.masterBars;
            const tick = this.api.tickPosition ?? 0;

            let bar = masterBars[0];
            for (const masterBar of masterBars) {
                if (masterBar.start <= tick) {
                    bar = masterBar;
                } else {
                    break;
                }
            }

            let bpm = 120;
            if (bar.tempoAutomations && bar.tempoAutomations.length > 0 && bar.tempoAutomations[0].value) {
                bpm = bar.tempoAutomations[0].value;
            }

            const beats = bar.timeSignatureNumerator ?? 4;
            const playbackSpeed = this.api.playbackSpeed ?? 1;
            return { bpm: bpm * playbackSpeed, beats };
        },

        /**
         * Play a count-in (one bar of metronome beats) via the Web Audio API,
         * then start the actual playback. Used for external audio sources where
         * alphaTab does not support count-in.
         */
        startExternalCountIn() {
            countIn.cancel();
            this.isCountingIn = true;

            const { bpm, beats } = this.getCountInInfo();
            countIn.start({
                bpm,
                beats,
                onFinished: () => {
                    this.isCountingIn = false;
                    if (this.playing) {
                        this.api.play();
                    }
                },
            });
        },

        /**
         * Restore the playback range that was saved before switching audio source.
         */
        restorePlaybackRange() {
            if (!this.savedPlaybackRange || !this.api) {
                return;
            }
            const range = this.savedPlaybackRange;
            this.api.playbackRange = range;

            clearTimeout(this.playbackRangeRestoreTimer);
            this.playbackRangeRestoreTimer = setTimeout(() => {
                this.savedPlaybackRange = null;
                this.playbackRangeRestoreTimer = undefined;
            }, 1500);
        },

        /**
         * If a playback range is highlighted, move the cursor to its start.
         * Switching audio sources re-creates the player / external element at
         * position 0, which drags the cursor back to the first bar.
         */
        seekToHighlightedRangeStart() {
            const range = this.api?.playbackRange;
            if (range) {
                this.api.tickPosition = range.startTick;
            }
        },

        /**
         * Play from the first bar containing notes in the current track
         * If offset is provided, play from the first bar containing notes after the offset bar
         */
        playFromFirstBarContainingNotes(offset = 0) {
            if (!this.api || !this.ready) {
                return;
            }

            // Find the first bar containing notes in the current track
            const track = this.api.score.tracks[this.selectedTrack];

            let targetBar = null;

            // Check the first staff only
            for (let i = 0; i < track.staves[0].bars.length; i++) {
                const bar = track.staves[0].bars[i];

                // See if bar contains any notes by scanning voices -> beats -> notes
                let hasNotes = false;
                if (bar && bar.voices) {
                    for (const voice of bar.voices) {
                        if (!voice || !voice.beats) continue;
                        for (const beat of voice.beats) {
                            if (beat && beat.notes && beat.notes.length > 0) {
                                hasNotes = true;
                                break;
                            }
                        }
                        if (hasNotes) break;
                    }
                }

                // Apply offset
                if (hasNotes) {
                    const bars = track.staves[0].bars;
                    // clamp target index between 0 and last bar index
                    const targetIndex = Math.max(0, Math.min(i + offset, bars.length - 1));
                    targetBar = bars[targetIndex];
                    break;
                }
            }

            if (targetBar) {
                const firstBeat = targetBar.voices[0].beats[0];
                api.tickPosition = firstBeat.absoluteDisplayStart;
            }

            this.startPlayback();
        },

        getFileURL(tempToken) {
            return baseURL + `/api/tab/${this.tabID}/file?tempToken=${tempToken}`;
        },

        async getTempToken() {
            const fileURL = baseURL + `/api/tab/${this.tabID}/temp-token`;

            // fetch the file as array buffer
            const response = await fetch(fileURL, {
                credentials: "include",
            });

            if (!response.ok) {
                throw new Error("Failed to get get temp token");
            }
            return (await response.json()).token;
        },

        /**
         * @param tempToken
         * @param trackID
         * @returns {Promise<number>} The actual trackID used
         */
        initContainer(tempToken, trackID) {
            return new Promise((resolve, reject) => {
                if (this.api) {
                    this.destroyContainer();
                }

                if (!(this.$refs.bassTabContainer instanceof HTMLElement)) {
                    reject(new Error("Container element not found"));
                }

                let displayResources = {
                    tablatureFont: "bold 14px Arial",
                    barNumberColor: "#6D6D6D",
                };

                if (this.setting.scoreColor === "dark") {
                    displayResources = {
                        ...displayResources,
                        staffLineColor: "#6D6D6D",
                        barSeparatorColor: "#6D6D6D",
                        mainGlyphColor: "#A4A4A4",
                        secondaryGlyphColor: "#A4A4A4",
                        scoreInfoColor: "#A3A3A3",
                        barNumberColor: "#6D6D6D",
                    };
                }

                let layoutMode = undefined;

                if (this.setting.scoreStyle === "horizontal-tab") {
                    layoutMode = alphaTab.LayoutMode.Horizontal;
                    this.$emit("setFixedHeader", true);
                }

                this.soundFontBank = this.setting.soundFont;
                this.soundFontFallbackTried = false;
                this.soundFontLoading = true;
                this.soundFontFailed = false;
                this.soundFontProgress = 0;
                this.soundFontLoaded = false;
                this.synthPlayerReady = false;
                this.synthReady = false;

                this.api = new alphaTab.AlphaTabApi(this.$refs.bassTabContainer, {
                    notation: {
                        // Hide tab rhythm when the score staff is visible (Tab + Score)
                        rhythmMode: alphaTab.TabRhythmMode.Automatic,
                        elements: {
                            scoreTitle: false,
                            scoreSubTitle: false,
                            scoreArtist: false,
                            scoreAlbum: false,
                            scoreWords: false,
                            scoreMusic: false,
                            scoreWordsAndMusic: false,
                            scoreCopyright: false,
                        },
                    },
                    core: {
                        file: this.getFileURL(tempToken),
                        //tracks: [trackID],
                        fontDirectory: "/font/",
                        engine: "html5",
                    },
                    player: {
                        enablePlayer: true,

                        // Always enable, so we can navigate to any position
                        enableCursor: true,
                        enableAnimatedBeatCursor: this.animatedCursor,
                        enableUserInteraction: true,
                        soundFont: this.soundFontURL(this.soundFontBank),
                        // Avoid initial scroll jump in scroll mode, which make it unable to see the title
                        scrollMode: ScrollMode.Off,
                        scrollOffsetY: -50,
                        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
                    },
                    display: {
                        staveProfile: this.getStaveProfile(),
                        resources: displayResources,
                        layoutMode,
                        scale: this.setting.scale,
                    },
                });

                // Exposing api to window for debugging
                window.api = this.api;

                // Custom selection handles + "click keeps the selection" behavior
                this.selectionController = setupSelection(this.$refs.bassTabContainer, this.api);

                // Used for showing/hiding the "Restart" button
                this.api.playbackRangeChanged.on(() => {
                    this.playbackRange = this.api.playbackRange;
                });

                // Restore the saved playback range once the new player is ready.
                // A source switch also resets the cursor to the first bar, so
                // put it back at the highlighted range start as well. Only do
                // this right after a source switch (while the range is saved),
                // and on a later tick once the re-initialized player settles.
                this.api.playerReady.on(() => {
                    this.synthPlayerReady = true;
                    this.syncSynthReady();
                    this.restorePlaybackRange();
                    if (this.savedPlaybackRange) {
                        setTimeout(() => this.seekToHighlightedRangeStart(), 0);
                    }
                });

                this.api.error.on((error) => {
                    queueMicrotask(() => {
                        if (this.handledSoundFontErrors.has(error)) {
                            return;
                        }
                        generalError(error);
                    });
                });
                this.api.player?.soundFontLoadFailed.on((error) => {
                    this.handleSoundFontLoadFailure(error);
                });

                this.api.soundFontLoad.on((progress) => {
                    this.soundFontProgress = progress.total > 0
                        ? Math.min(100, Math.round(progress.loaded / progress.total * 100))
                        : 0;
                });
                this.api.soundFontLoaded.on(() => {
                    this.soundFontLoading = false;
                    this.soundFontFailed = false;
                    this.soundFontLoaded = true;
                    this.soundFontProgress = 100;
                    this.syncSynthReady();
                });

                // Clicking on the score seeks. When already playing with count-in
                // enabled, restart from the clicked beat with a count-in.
                this.api.beatMouseDown.on((beat) => {
                    this.seekDownBeat = this.getBeatKey(beat);
                });
                this.api.beatMouseUp.on((beat) => {
                    const downKey = this.seekDownBeat;
                    this.seekDownBeat = null;

                    // Only a plain click (same beat down/up), not a drag-selection
                    if (!downKey || downKey !== this.getBeatKey(beat)) {
                        return;
                    }

                    // When a range is selected, only clicks inside it count
                    if (this.selectionController && !this.selectionController.isWithinSelection(beat)) {
                        return;
                    }

                    if (this.playing && this.enableCountIn) {
                        this.startPlayback();
                    }
                });

                // iOS 16.4+: Enable audio playback even when silent switch is ON
                if ("audioSession" in navigator) {
                    try {
                        navigator.audioSession.type = "playback";
                    } catch (error) {
                        console.error("Failed to set navigator.audioSession.type to 'playback':", error);
                    }
                }

                // Score Loaded
                this.api.scoreLoaded.on(async (score) => {
                    console.log("Score loaded");

                    this.applyColors(score);

                    // Track
                    // -1: never picked; auto-select the preferred instrument track
                    if (trackID === -1) {
                        trackID = findPreferredTrack(score.tracks, this.setting.preferredInstrument)?.index ?? 0;
                    }
                    if (trackID < 0 || trackID >= score.tracks.length) {
                        trackID = 0;
                    }

                    this.selectedTrack = trackID;

                    if (this.isDrum()) {
                        this.api.settings.display.staveProfile = StaveProfile.ScoreTab;
                    } else {
                        // This will break drum score
                        this.overrideHiddenStaves(score);
                    }

                    this.api.renderTracks([this.api.score.tracks[trackID]]);

                    // Always show tempo automation on the master bar
                    if (api.score.masterBars.length > 0 && api.score.masterBars[0].tempoAutomations.length > 0) {
                        api.score.masterBars[0].tempoAutomations[0].isVisible = true;
                    }

                    // Get key signature
                    const firstBar = this.api.score.tracks[trackID].staves[0].bars[0];
                    this.keySignature = getKeySignature(firstBar);

                    // Set Audio source
                    this.currentAudio = this.getConfig("audio", "synth");

                    // Metronome
                    this.enableMetronome = this.getConfig("enableMetronome", false);

                    // Count in
                    this.enableCountIn = this.getConfig("enableCountIn", false);

                    // Looping
                    this.isLooping = this.getConfig("isLooping", false);

                    // Speed
                    this.speed = 100;
                    this.speed = this.getConfig("speed", 100);

                    // Scroll Mode
                    // Force Smooth from horizontal tab
                    if (this.setting.scoreStyle === "horizontal-tab") {
                        this.scrollMode = ScrollMode.Smooth;
                    } else {
                        this.scrollMode = this.setting.scrollMode;
                    }

                    this.tracks = [];

                    // List all tracks
                    score.tracks.forEach((track) => {
                        let name = (track.name ?? "").trim();
                        if (!name) {
                            name = (track.shortName ?? "").trim();
                        }
                        if (!name) {
                            name = getInstrumentName(track.playbackInfo.program);
                        }
                        this.tracks.push({
                            id: track.index,
                            name,
                            program: track.playbackInfo.program,
                        });
                    });

                    this.selectedTrack = trackID;

                    this.enableBackingTrack = this.hasBackingTrack();

                    this.ready = true;
                    resolve(trackID);
                });

                this.api.playerFinished.on(() => {
                    if (!this.isLooping) {
                        this.playing = false;
                    } else if (this.enableCountIn) {
                        // Looping a highlighted range wraps back to its start and
                        // keeps playing; count in again before the next iteration.
                        const range = this.api.playbackRange;
                        if (range) {
                            this.api.tickPosition = range.startTick;
                        }
                        this.startPlayback();
                    }
                });
            });
        },

        destroyContainer() {
            this.api?.destroy();
            this.api = undefined;

            // Remove custom selection handles + restore alphaTab's default method
            this.selectionController?.clear();
            this.selectionController = null;

            // Reset states
            this.ready = false;
            this.playing = false;
            this.currentAudio = "synth";
            this.enableMetronome = false;
            this.enableCountIn = false;
            this.isLooping = false;
            this.speed = 100;
            this.scrollMode = ScrollMode.Continuous;
            this.soloTrackID = -1;
            this.youtube = {};
            this.simpleSyncSecond = -1;
            this.muteTrackList = {};
            this.playbackRange = null;
            this.savedPlaybackRange = null;
            clearTimeout(this.playbackRangeRestoreTimer);
            this.playbackRangeRestoreTimer = undefined;
            countIn.cancel();
            this.isCountingIn = false;
            this.seekDownBeat = null;
        },

        simpleSync(offset) {
            // Apply sync points
            const syncPoints = [
                { "barIndex": 0, "barOccurence": 0, "barPosition": 0, "millisecondOffset": offset },
            ];
            this.api.score.applyFlatSyncPoints(syncPoints);
        },

        advancedSync(syncPointsText) {
            const syncPoints = convertAlphaTexSyncPoint(syncPointsText);
            this.api.score.applyFlatSyncPoints(syncPoints);
            console.log("Applying advanced sync points:", syncPoints);
        },

        // Style the score with custom colors
        applyColors(score) {
            let stringColors = {
                1: alphaTab.model.Color.fromJson("#bf3732"),
                2: alphaTab.model.Color.fromJson("#fff800"),
                3: alphaTab.model.Color.fromJson("#0080ff"),
                4: alphaTab.model.Color.fromJson("#e07b39"),
                5: alphaTab.model.Color.fromJson("#2A8E08"),
                6: alphaTab.model.Color.fromJson("#A349A4"),
            };

            if (this.setting.scoreColor === "light") {
                stringColors[2] = alphaTab.model.Color.fromJson("#b5a33a");
            }

            // traverse hierarchy and apply colors as desired
            for (const track of score.tracks) {
                for (const staff of track.staves) {
                    console.log(this.setting.noteColor, staff.stringTuning.tunings.length);

                    // Coloring 5string bass line for louis-bass-v
                    if (this.setting.noteColor === "louis-bass-v" && staff.stringTuning.tunings.length === 5) {
                        stringColors = {
                            1: alphaTab.model.Color.fromJson("#b1da68"),
                            2: alphaTab.model.Color.fromJson("#bf3732"),
                            3: alphaTab.model.Color.fromJson("#fff800"),
                            4: alphaTab.model.Color.fromJson("#0080ff"),
                            5: alphaTab.model.Color.fromJson("#e07b39"),
                        };
                    }

                    for (const bar of staff.bars) {
                        for (const voice of bar.voices) {
                            for (const beat of voice.beats) {
                                if (this.setting.noteColor !== "none") {
                                    for (const note of beat.notes) {
                                        note.style = new alphaTab.model.NoteStyle();
                                        note.style.colors.set(alphaTab.model.NoteSubElement.GuitarTabFretNumber, stringColors[note.string]);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },

        /**
         * Override hidden staves based on Style settings to fix Guitar Pro hidden tabs.
         * ⚠️ This will break drum score
         * - Style "tab": showTablature = true, showStandardNotation = false
         * - Style "score": showTablature = false, showStandardNotation = true
         * - Style "score-tab": both = true
         */
        overrideHiddenStaves(score) {
            for (const track of score.tracks) {
                for (const staff of track.staves) {
                    // Override visibility flags based on user's Style setting
                    if (this.setting.scoreStyle === "tab" || this.setting.scoreStyle === "horizontal-tab") {
                        staff.showTablature = true;
                        staff.showStandardNotation = false;
                    } else if (this.setting.scoreStyle === "score") {
                        staff.showTablature = false;
                        staff.showStandardNotation = true;
                    } else if (this.setting.scoreStyle === "score-tab") {
                        staff.showTablature = true;
                        staff.showStandardNotation = true;
                    }
                }
            }
        },

        async initSocketIO() {
            if (this.socket) {
                this.socket.disconnect();
                this.socket = null;
            }
            this.socket = connectSocketIO();

            this.socket.on("connect", () => {
                console.log("Connected to server");
            });

            this.socket.on("disconnect", () => {
                console.log("Disconnected from server");
            });

            // Play
            this.socket.on("play", () => {
                this.play();
            });

            // Pause
            this.socket.on("pause", () => {
                this.pause();
            });

            // Seek
            this.socket.on("seek", (time) => {
                if (!this.api) {
                    return;
                }
                const diff = Math.abs(this.api.timePosition - time);
                console.log(this.api.timePosition, time, diff);
                if (diff < 100) {
                    return;
                }
                this.api.timePosition = time;
            });

            this.socket.on("no-audio", () => {
                this.currentAudio = "none";
            });
        },

        async audioYoutube(videoID) {
            this.currentAudio = "youtube-" + videoID;
            this.closeAllList();
        },

        async audioFile(filename) {
            this.currentAudio = "audio-" + filename;
            this.closeAllList();
        },

        async initAudio(filename) {
            if (!this.api) {
                return;
            }

            this.isInitializingAudio = true;
            this.closeAllList();

            const audioPlayer = this.$refs.audioPlayer;

            // Init the audio handler if not exists
            if (!this.audioHandler) {
                this.audioHandler = {
                    get backingTrackDuration() {
                        const duration = audioPlayer.duration;
                        return Number.isFinite(duration) ? duration * 1000 : 0;
                    },
                    get playbackRate() {
                        return audioPlayer.playbackRate;
                    },
                    set playbackRate(value) {
                        audioPlayer.playbackRate = value;
                    },
                    get masterVolume() {
                        return audioPlayer.volume;
                    },
                    set masterVolume(value) {
                        audioPlayer.volume = value;
                    },
                    seekTo(time) {
                        audioPlayer.currentTime = time / 1000;
                    },
                    play() {
                        audioPlayer.play();
                    },
                    pause() {
                        audioPlayer.pause();
                    },
                };

                let updateTimer = 0;
                const onTimeUpdate = () => {
                    // Synth output lacks updatePosition during source switches
                    this.api?.player?.output?.updatePosition?.(
                        audioPlayer.currentTime * 1000,
                    );
                };

                audioPlayer.addEventListener("timeupdate", onTimeUpdate);
                audioPlayer.addEventListener("seeked", onTimeUpdate);
                audioPlayer.addEventListener("play", () => {
                    window.clearInterval(updateTimer);
                    this.playing = true;
                    this.api?.play();
                    updateTimer = window.setInterval(onTimeUpdate, 50);
                });

                // state updates
                audioPlayer.addEventListener("pause", () => {
                    // If the audio ended, the "pause" event will also be triggered
                    // Ignore this, because we have "ended" event to handle it
                    if (audioPlayer.ended) {
                        return;
                    }

                    // Ignore the pause caused by restarting with a count-in,
                    // otherwise it would cancel the pending count-in playback.
                    if (this.isCountingIn) {
                        return;
                    }

                    console.log("[audioPlayer] paused");
                    this.playing = false;
                    this.api.pause();
                    window.clearInterval(updateTimer);
                });
                audioPlayer.addEventListener("ended", () => {
                    console.log("[audioPlayer] ended");

                    // If isLooping is true, seek to the beginning and play again
                    // Else just pause
                    if (this.isLooping) {
                        audioPlayer.currentTime = 0;
                        audioPlayer.play();
                    } else {
                        this.playing = false;
                        this.api.pause();
                        window.clearInterval(updateTimer);
                    }
                });
                audioPlayer.addEventListener("volumechange", () => {
                    this.api.masterVolume = audioPlayer.volume;
                });
                audioPlayer.addEventListener("ratechange", () => {
                    this.api.playbackSpeed = audioPlayer.playbackRate;
                });
            }

            // Bug? If change to EnabledExternalMedia, and this.api.updateSettings(), this sync point can not be applied correctly.
            // So it must change to EnabledSynthesizer first, then change to EnabledExternalMedia
            this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
            this.api.updateSettings();

            let found = false;
            let syncMethod = null;
            let syncData = null;

            // Get offset from audioList
            for (const audio of this.audioList) {
                if (audio.filename === filename) {
                    this.audio = audio;
                    syncMethod = audio.syncMethod;
                    syncData = audio.syncMethod === "advanced" ? audio.advancedSync : audio.simpleSync;

                    if (audio.syncMethod === "advanced") {
                        this.advancedSync(audio.advancedSync);
                    } else {
                        this.simpleSync(audio.simpleSync);
                    }
                    found = true;
                    break;
                }
            }

            // Probably provided an audio file not in the list, switch to synth
            if (!found) {
                this.isInitializingAudio = false;
                notify({
                    type: "error",
                    title: "Error",
                    text: "Audio file not found, fallback to synth.",
                });
                this.currentAudio = "synth";
                return;
            }

            this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
            this.api.updateSettings();

            this.api.player.output.handler = this.audioHandler;

            const path = baseURL + `/api/tab/${this.tabID}/audio/${encodeURIComponent(filename)}`;

            audioPlayer.src = path;
            audioPlayer.load();
            audioPlayer.playbackRate = this.api.playbackSpeed;

            // Switching in an external audio element resets it to position 0,
            // which drags the cursor to the first bar. If a playback range is
            // highlighted, seek the cursor back to its start once the audio is
            // actually loaded (earlier seeks are ignored by the element).
            audioPlayer.addEventListener("loadeddata", () => this.seekToHighlightedRangeStart(), { once: true });
            audioPlayer.addEventListener("canplay", () => this.seekToHighlightedRangeStart(), { once: true });
            if (audioPlayer.readyState >= 1) {
                this.seekToHighlightedRangeStart();
            }

            this.pause();

            // Re-apply sync points after pause() completes (pause triggers playing watcher which calls updateSettings)
            await this.$nextTick();
            if (syncMethod === "advanced") {
                this.advancedSync(syncData);
            } else {
                this.simpleSync(syncData);
            }

            this.isInitializingAudio = false;
        },

        clearYoutubePlaybackInterval() {
            if (this.youtubePlaybackInterval !== undefined) {
                window.clearInterval(this.youtubePlaybackInterval);
                this.youtubePlaybackInterval = undefined;
            }
        },

        youtubeErrorDetails(code) {
            switch (code) {
                case 2:
                    return { message: "İstek bilgisi geçersiz. Video bağlantısını ve kodunu kontrol edin.", retryable: false };
                case 5:
                    return { message: "YouTube oynatıcısı bu videoyu tarayıcıda açamadı.", retryable: true };
                case 100:
                    return { message: "Video bulunamadı, kaldırılmış veya gizli.", retryable: false };
                case 101:
                    return { message: "Video sahibi, videonun başka sitelerde oynatılmasına izin vermiyor.", retryable: false };
                case 150:
                    return {
                        message: window.location.hostname === "127.0.0.1"
                            ? "Bu video 127.0.0.1 adresinde oynatılamadı. localhost adresini deneyin."
                            : "Video sahibi, videonun başka sitelerde oynatılmasına izin vermiyor.",
                        retryable: false,
                    };
                case 153:
                    return {
                        message: window.location.hostname === "127.0.0.1"
                            ? "YouTube gerekli site bilgisini alamadı. localhost adresini deneyin."
                            : "YouTube gerekli site bilgisini alamadı. Tarayıcı gizlilik ayarlarını kontrol edin.",
                        retryable: true,
                    };
                default:
                    return { message: "YouTube bu videoyu oynatamadı.", retryable: true };
            }
        },

        setYoutubeError(code, videoID, message, retryable = false) {
            if (!videoID || this.currentAudio !== `youtube-${videoID}`) {
                return;
            }

            this.clearYoutubePlaybackInterval();
            if (this.playing) {
                this.pause();
            } else {
                this.api?.pause();
            }

            const details = code === null ? { message, retryable } : this.youtubeErrorDetails(code);
            this.youtubeError = { videoID, code, ...details };
        },

        handleYoutubePlayerError(event) {
            const videoID = event?.target?.getVideoData?.()?.video_id || this.youtubeVideoID;
            const activeVideoID = this.currentAudio.startsWith("youtube-") ? this.currentAudio.substring(8) : null;
            if (!activeVideoID || activeVideoID !== videoID) {
                return;
            }

            const code = Number.isInteger(event?.data) ? event.data : null;
            this.setYoutubeError(code, videoID, "YouTube bu videoyu açamadı.", true);
        },

        async retryYoutube() {
            const videoID = this.youtubeError?.videoID;
            if (!videoID) return;
            this.youtubeError = null;
            await this.initYoutube(videoID);
        },

        async initYoutube(videoID) {
            const requestID = ++this.youtubeRequestID;
            this.youtubeVideoID = videoID;
            this.youtubeError = null;
            this.isInitializingAudio = true;
            this.closeAllList();
            this.clearYoutubePlaybackInterval();

            try {
                if (!this.youtubePlayerReady) {
                    await this.initYoutubePlayer();
                }
                if (requestID !== this.youtubeRequestID || this.currentAudio !== `youtube-${videoID}`) return;

                const youtube = this.youtubeList.find((video) => video.videoID === videoID);
                if (!youtube) {
                    this.setYoutubeError(null, videoID, "Bu video bu sekmenin listesinde değil.", false);
                    return;
                }
                this.youtube = youtube;

                // Bug? If change to EnabledExternalMedia, and this.api.updateSettings(), this sync point can not be applied correctly.
                // So it must change to EnabledSynthesizer first, then change to EnabledExternalMedia
                this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
                this.api.updateSettings();

                const syncData = youtube.syncMethod === "advanced" ? youtube.advancedSync : youtube.simpleSync;
                if (youtube.syncMethod === "advanced") {
                    this.advancedSync(youtube.advancedSync);
                } else {
                    this.simpleSync(youtube.simpleSync);
                }

                this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
                this.api.updateSettings();
                this.api.player.output.handler = this.alphaTabYoutubeHandler;
                this.youtubePlayer.cueVideoById(videoID);
                this.youtubePlayer.setPlaybackRate(this.api.playbackSpeed);
                this.pause();

                // Re-apply sync points after pause() completes (pause triggers playing watcher which calls updateSettings)
                await this.$nextTick();
                if (requestID !== this.youtubeRequestID || this.currentAudio !== `youtube-${videoID}`) return;
                if (youtube.syncMethod === "advanced") {
                    this.advancedSync(syncData);
                } else {
                    this.simpleSync(syncData);
                }
            } catch (error) {
                if (requestID === this.youtubeRequestID && this.currentAudio === `youtube-${videoID}` && !this.youtubeError) {
                    const code = Number.isInteger(error?.data) ? error.data : null;
                    if (code === null) {
                        this.setYoutubeError(null, videoID, error?.message || "YouTube oynatıcısı başlatılamadı.", true);
                    } else {
                        this.setYoutubeError(code, videoID, "YouTube bu videoyu açamadı.", true);
                    }
                }
            } finally {
                if (requestID === this.youtubeRequestID) {
                    this.isInitializingAudio = false;
                }
            }
        },

        initYoutubePlayer() {
            if (this.youtubePlayerReady) return Promise.resolve();
            if (this.youtubePlayerPromise) return this.youtubePlayerPromise;

            this.youtubePlayerPromise = this.createYoutubePlayer().finally(() => {
                this.youtubePlayerPromise = null;
            });
            return this.youtubePlayerPromise;
        },

        async createYoutubePlayer() {
            const playerLifecycle = this.youtubePlayerLifecycle;
            const warningTimer = window.setTimeout(() => {
                notify({
                    type: "warning",
                    title: "YouTube yavaş yanıt veriyor",
                    text: "Oynatıcı yüklenmeye devam ediyor.",
                });
            }, 5000);
            this.youtubeWarningTimeout = warningTimer;

            let player;
            let readyTimeout;
            let cancelPlayerReady;
            try {
                await loadYoutubeIframeApi();
                if (playerLifecycle !== this.youtubePlayerLifecycle) throw new Error("YouTube oynatıcı başlatma isteği iptal edildi.");
                if (!this.$refs.youtube) throw new Error("YouTube oynatıcı alanı bulunamadı.");

                this.$refs.youtube.innerHTML = "";
                const playerElement = document.createElement("div");
                this.$refs.youtube.appendChild(playerElement);

                const ready = Promise.withResolvers();
                let readyReceived = false;
                cancelPlayerReady = () => ready.reject(new Error("YouTube oynatıcı başlatma isteği iptal edildi."));
                this.youtubePlayerCancel = cancelPlayerReady;
                readyTimeout = window.setTimeout(() => ready.reject(new Error("YouTube oynatıcısı zamanında hazır olmadı.")), 20000);
                player = new YT.Player(playerElement, {
                    height: "200",
                    width: "320",
                    playerVars: { autoplay: 0, origin: window.location.origin },
                    events: {
                        onReady: () => {
                            readyReceived = true;
                            ready.resolve();
                        },
                        onStateChange: (event) => {
                            if (this.youtubePlayer !== player || this.currentAudio !== `youtube-${this.youtubeVideoID}` || this.youtubePlaybackFailed) return;
                            switch (event.data) {
                                case YT.PlayerState.PLAYING:
                                    this.clearYoutubePlaybackInterval();
                                    this.youtubePlaybackInterval = window.setInterval(() => {
                                        if (this.youtubePlayer === player && this.currentAudio === `youtube-${this.youtubeVideoID}` && !this.youtubePlaybackFailed) {
                                            this.api?.player?.output?.updatePosition?.(player.getCurrentTime() * 1000);
                                        }
                                    }, 50);
                                    this.playing = true;
                                    this.api?.play();
                                    break;
                                case YT.PlayerState.ENDED:
                                    this.clearYoutubePlaybackInterval();
                                    this.playing = false;
                                    this.api?.stop();
                                    break;
                                case YT.PlayerState.PAUSED:
                                    this.clearYoutubePlaybackInterval();
                                    if (this.isCountingIn) break;
                                    this.playing = false;
                                    this.api?.pause();
                                    break;
                                default:
                                    break;
                            }
                        },
                        onPlaybackRateChange: (event) => {
                            if (this.youtubePlayer === player && this.currentAudio === `youtube-${this.youtubeVideoID}` && this.api) {
                                this.api.playbackSpeed = event.data;
                            }
                        },
                        onError: (event) => {
                            if (!readyReceived) ready.reject(event);
                            this.handleYoutubePlayerError(event);
                        },
                    },
                });

                this.youtubePlayer = player;
                await ready.promise;
                if (playerLifecycle !== this.youtubePlayerLifecycle) throw new Error("YouTube oynatıcı başlatma isteği iptal edildi.");
                this.youtubePlayerReady = true;

                let initialSeek = -1;
                this.alphaTabYoutubeHandler = {
                    get backingTrackDuration() {
                        return player.getDuration() * 1000;
                    },
                    get playbackRate() {
                        return player.getPlaybackRate();
                    },
                    set playbackRate(value) {
                        player.setPlaybackRate(value);
                    },
                    get masterVolume() {
                        return player.getVolume() / 100;
                    },
                    set masterVolume(value) {
                        player.setVolume(value * 100);
                    },
                    seekTo(time) {
                        if (player.getPlayerState() !== YT.PlayerState.PAUSED && player.getPlayerState() !== YT.PlayerState.PLAYING) {
                            initialSeek = time / 1000;
                        } else {
                            player.seekTo(time / 1000);
                        }
                    },
                    play() {
                        player.playVideo();
                        if (initialSeek >= 0) {
                            player.seekTo(initialSeek);
                            initialSeek = -1;
                        }
                    },
                    pause() {
                        player.pauseVideo();
                    },
                };
            } catch (error) {
                if (this.youtubePlayer === player) {
                    player?.destroy?.();
                    this.youtubePlayer = null;
                }
                this.youtubePlayerReady = false;
                throw error;
            } finally {
                window.clearTimeout(warningTimer);
                window.clearTimeout(readyTimeout);
                if (this.youtubePlayerCancel === cancelPlayerReady) {
                    this.youtubePlayerCancel = null;
                }
                if (this.youtubeWarningTimeout === warningTimer) this.youtubeWarningTimeout = undefined;
            }
        },

        destroyYoutubePlayer() {
            this.youtubePlayerLifecycle++;
            this.youtubeRequestID++;
            this.youtubeError = null;
            this.youtubeVideoID = null;
            this.clearYoutubePlaybackInterval();
            window.clearTimeout(this.youtubeWarningTimeout);
            this.youtubeWarningTimeout = undefined;
            this.youtubePlayerCancel?.();
            this.youtubePlayerCancel = null;
            this.youtubePlayer?.destroy?.();
            this.youtubePlayer = null;
            this.youtubePlayerReady = false;
            this.youtubePlayerPromise = null;
            this.alphaTabYoutubeHandler = null;
        },

        getStaveProfile() {
            if (this.setting.scoreStyle === "tab" || this.setting.scoreStyle === "horizontal-tab") {
                return StaveProfile.Tab;
            } else if (this.setting.scoreStyle === "score") {
                return StaveProfile.Score;
            } else if (this.setting.scoreStyle === "score-tab") {
                return StaveProfile.ScoreTab;
            } else {
                return StaveProfile.Default;
            }
        },

        async audioSynth() {
            this.currentAudio = "synth";
            this.closeAllList();
        },

        async initSynth() {
            this.api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
            this.api.updateSettings();
            this.pause();
        },

        async audioBackingTrack() {
            if (!this.hasBackingTrack()) {
                notify({
                    type: "error",
                    title: "Error",
                    text: "No backing track found in this tab.",
                });
                return;
            }
            this.currentAudio = "backingTrack";
            this.closeAllList();
        },

        /**
         * Check if the current track is a drum track (program 0).
         * this.selectedTrack must be set before calling this function.
         * @returns {boolean}
         */
        isDrum() {
            if (!this.api || !this.api.score || !this.api.score.tracks) {
                return false;
            }
            const track = this.api.score.tracks[this.selectedTrack];
            return track.playbackInfo.program === 0;
        },

        /**
         * Change the displayed track.
         * @param trackID
         * @returns {Promise<void>}
         */
        async changeTrack(trackID) {
            const fromDrum = this.isDrum();
            this.selectedTrack = trackID;
            const isDrum = this.isDrum();

            // If switching from/to drum track, need to re-render the whole score
            // Due to the bug that Drum is not able to render in Tab View
            if (fromDrum || isDrum) {
                await this.load(trackID);
            } else {
                this.api.renderTracks([this.api.score.tracks[trackID]]);
                this.setConfig("trackID", trackID);
            }

            // A practice range is tied to the previous instrument's bars, so it
            // must not carry over to the newly selected track.
            this.api.playbackRange = null;
            this.api.clearPlaybackRangeHighlight();

            this.closeAllList();
        },

        showList(type) {
            if (type === "track") {
                this.showTrackList = !this.showTrackList;
                this.showAudioList = false;
            } else if (type === "audio") {
                this.showAudioList = !this.showAudioList;
                this.showTrackList = false;
            }
        },

        closeAllList() {
            this.showTrackList = false;
            this.showAudioList = false;
        },

        toggleSolo(trackID) {
            if (!this.api) {
                return;
            }

            if (this.soloTrackID === trackID) {
                this.api.changeTrackMute(this.api.score.tracks, false);
                this.soloTrackID = -1;
                this.muteTrackList = {};
            } else {
                const muteList = [];
                const soloList = [];

                for (const track of this.api.score.tracks) {
                    if (track.index !== trackID) {
                        muteList.push(track);
                        this.muteTrackList[track.index] = true;
                    } else {
                        soloList.push(track);
                        this.muteTrackList[track.index] = false;
                    }
                }

                this.api.changeTrackMute(muteList, true);
                this.api.changeTrackMute(soloList, false);

                this.soloTrackID = trackID;
            }
        },

        toggleMute(trackID) {
            this.soloTrackID = -1;

            this.muteTrackList[trackID] = !this.muteTrackList[trackID];

            const mute = this.muteTrackList[trackID];

            this.api.changeTrackMute([
                this.api.score.tracks[trackID],
            ], mute);
        },

        toggleVolume(trackID, volume) {
            if (!this.api) {
                return;
            }
            const track = this.api.score.tracks.find(({ index }) => index === trackID);
            this.api.changeTrackVolume(track, volume / 100);
        },

        edit() {
            this.$router.push(`/tab/${this.tabID}/edit/info`);
        },

        hasBackingTrack() {
            return !!this.api.score.backingTrack;
        },

        setConfig(key, value) {
            localStorage.setItem(`tab-${this.tabID}-${key}`, JSON.stringify(value));
        },

        getConfig(key, defaultValue) {
            const value = localStorage.getItem(`tab-${this.tabID}-${key}`);
            if (value === null) {
                return defaultValue;
            }
            return JSON.parse(value);
        },

        async saveYoutube() {
            let res;
            try {
                res = await fetch(baseURL + `/api/tab/${this.tabID}/youtube/${this.youtube.videoID}`, {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        syncMethod: this.youtube.syncMethod,
                        simpleSync: this.youtube.simpleSync,
                        advancedSync: this.youtube.advancedSync,
                    }),
                });

                await checkFetch(res);
            } catch (e) {
                generalError(e);
            }
        },

        async saveAudio() {
            let res;
            try {
                res = await fetch(baseURL + `/api/tab/${this.tabID}/audio/${this.audio.filename}`, {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        syncMethod: this.audio.syncMethod,
                        simpleSync: this.audio.simpleSync,
                        advancedSync: this.audio.advancedSync,
                    }),
                });

                await checkFetch(res);
            } catch (e) {
                generalError(e);
            }
        },

        /**
         * Move the cursor to the previous/next bar.
         * @param steps Number of bars to move. Negative for previous bars.
         */
        moveToBar(steps) {
            try {
                if (!this.api || !this.api.score || !this.api.score.masterBars || this.api.score.masterBars.length === 0) {
                    return;
                }

                const masterBars = this.api.score.masterBars;
                const currentTick = Number(this.api.tickPosition ?? 0);
                let index = 0;
                for (let i = 0; i < masterBars.length; i++) {
                    const masterBarStart = masterBars[i].start ?? 0;
                    if (masterBarStart <= currentTick) {
                        index = i;
                    } else {
                        break;
                    }
                }

                let target = index + steps;
                if (target < 0) target = 0;
                if (target >= masterBars.length) target = masterBars.length - 1;

                const targetTick = masterBars[target].start ?? 0;
                this.api.tickPosition = targetTick;
            } catch (err) {
                console.error("moveToBar error:", err);
            }
        },
    },
});
</script>

<template>
    <div class="main" :class='{ "light": this.setting.scoreColor === "light" }'>
        <h1>{{ tab.title }}</h1>
        <div v-if="!synthReady && !soundFontFailed" class="text-center text-secondary mb-2">
            <span v-if="soundFontLoaded">Sesler hazırlanıyor</span>
            <span v-else>{{ soundFontLabel }} yükleniyor</span>: %{{ soundFontProgress }}
            <progress :value="soundFontProgress" max="100" aria-label="Ses bankası yükleniyor"></progress>
        </div>
        <div v-else-if="soundFontFailed" class="text-center text-warning mb-2">
            Sesler yüklenemedi. <button class="btn btn-sm btn-secondary" @click="retrySoundFont">Yeniden dene</button>
        </div>
        <h2>{{ tab.artist }}</h2>
        <div class="key-signature badge bg-secondary" v-if="keySignature && setting.showKeySignature">
            {{ keySignature }}
        </div>
        <div ref="bassTabContainer" v-pre></div>

        <!-- Just add a margin, don't let youtube player overlay the tab -->
        <div :class='{ "yt-margin": currentAudio.startsWith(`youtube-`) }'></div>

        <div class="toolbar" :class='{ "auto-hide": setting.toolbarAutoHide }'>
            <div class="scroll">
                <div class="track-selector selector" ref="trackSelector">
                    <div class="button" @click='showList("track")'>
                        <span v-if="tracks.length > 0">{{ tracks[selectedTrack].name }}</span>
                        <span v-else>Loading...</span>
                    </div>
                </div>

                <div class="audio-selector selector" ref="audioSelector">
                    <div class="button" @click='showList("audio")'>
                        Audio
                    </div>
                </div>

                <button class="btn btn-warning" @click="playFromHighlightedRange()" v-if="playbackRange">
                    <font-awesome-icon :icon='["fas", "play"]' />
                    Restart
                </button>

                <button class="btn btn-primary" @click="playPause" :class="{ active: playing }" :disabled="(currentAudio === 'synth' && !synthReady) || youtubePlaybackFailed || youtubeLoading">
                    <span v-if="!playing">
                        <font-awesome-icon :icon='["fas", "play"]' />
                        Play
                    </span>
                    <span v-else>
                        <font-awesome-icon :icon='["fas", "pause"]' />
                        Pause
                    </span>
                </button>
                <button class="btn btn-secondary" @click="loop()" :class="{ active: isLooping }">
                    <font-awesome-icon :icon='["fas", "check"]' v-if="isLooping" />
                    Loop
                </button>
                <button class="btn btn-secondary" @click="countIn()" :class='{ active: enableCountIn }'>
                    <font-awesome-icon :icon='["fas", "check"]' v-if="enableCountIn" />
                    Count in
                </button>
                <button class="btn btn-secondary" @click="metronome()" :class='{ active: enableMetronome, disabled: currentAudio !== "synth" }'>
                    <font-awesome-icon :icon='["fas", "check"]' v-if="enableMetronome" />
                    Metronome
                </button>

                <div class="select-percentage">
                    Speed: <input type="number" class="form-control" min="0" max="1000" step="1" v-model="speed" /> (%)
                </div>

                <div class="btn-edit" v-if="isLoggedIn">
                    <button class="btn btn-secondary" @click="edit()">
                        Edit
                    </button>
                </div>
            </div>

            <div class="track-list list" v-if="showTrackList" ref="trackList">
                <div class="p-2 text-end list-header">
                    <font-awesome-icon :icon='["fas", "xmark"]' class="me-2 close" @click="showTrackList = false" />
                </div>

                <div class="track item" v-for="track in tracks" :key="track.id" :class="{ active: selectedTrack === track.id }">
                    <div class="name" @click="changeTrack(track.id)">{{ track.name }}</div>
                    <div class="list-button solo" @click="toggleSolo(track.id)" :class="{ active: soloTrackID === track.id }">Solo</div>
                    <div class="list-button mute" @click="toggleMute(track.id)" :class="{ active: muteTrackList[track.id] }">Mute</div>
                    <div class="list-button select-percentage">
                        Volume: <input type="number" min="0" max="1000" step="1" value="100" @change="toggleVolume(track.id, $event.target.value)" /> (%)
                    </div>
                </div>
            </div>

            <div class="audio-list list" v-if="showAudioList" ref="audioList">
                <div class="p-2 text-end list-header">
                    <font-awesome-icon :icon='["fas", "xmark"]' class="me-2 close" @click="showAudioList = false" />
                </div>

                <div class="audio item" @click="audioSynth" :class='{ active: currentAudio === "synth" }'>
                    <div class="name">Örnek sesler ({{ soundFontLabel }})</div>
                </div>

                <div class="audio item" @click="audioBackingTrack" :class='{ active: currentAudio === "backingTrack" }' v-if="enableBackingTrack">
                    <div class="name">Embedded Backing Track</div>
                </div>

                <div class="audio item" @click="audioYoutube(youtube.videoID)" v-for="youtube in youtubeList" :key="youtube.id" :class='{ active: currentAudio === "youtube-" + youtube.videoID }'>
                    <div class="name">Youtube: {{ youtube.videoID }}</div>
                </div>

                <div class="audio item" @click="audioFile(audio.filename)" v-for="audio in audioList" :key="audio.filename" :class='{ active: currentAudio === "audio-" + audio.filename }'>
                    <div class="name">{{ audio.filename }}</div>
                </div>

                <!-- No Audio -->
                <div
                    class="audio item"
                    @click='currentAudio = "none";
                    closeAllList()'
                    :class='{ active: currentAudio === "none" }'
                >
                    <div class="name">No Audio (Mute)</div>
                </div>

                <div class="ms-4 me-4 mt-3 mb-3" v-if="isLoggedIn">
                    <router-link :to="`/tab/${tab.id}/edit/audio`">Add Youtube or Audio File...</router-link>
                </div>
            </div>

            <!-- USE v-show, because youtube player is not vue  -->
            <div v-show='currentAudio.startsWith("youtube-") || currentAudio.startsWith("audio-")' class="player-container">
                <!-- Simple sync edit -->
                <div class="sync-offset ps-3 pe-3 p-2" v-if='syncMethod === "simple" && isLoggedIn && setting.showSyncOffset'>
                    Sync Offset: <input type="number" class="form-control" min="-100000" max="100000" step="0.1" v-model="simpleSyncSecond" /> s
                </div>

                <!-- Youtube Player -->
                <div v-show='currentAudio.startsWith("youtube-")' class="youtube-view">
                    <div v-if="youtubeLoading" class="alert alert-secondary mb-0" role="status">Video hazırlanıyor…</div>
                    <div ref="youtube" class="player"></div>
                    <div v-if="youtubePlaybackFailed" class="youtube-error alert alert-danger mb-0" role="alert">
                        <p class="mb-1">{{ youtubeError.message }}</p>
                        <p class="mb-2" v-if="youtubeError.code !== null">YouTube hata kodu: {{ youtubeError.code }}</p>
                        <a class="d-block mb-2" :href="`https://www.youtube.com/watch?v=${youtubeError.videoID}`" target="_blank" rel="noopener noreferrer">YouTube'da izle</a>
                        <a v-if="youtubeLocalhostHref && [150, 153].includes(youtubeError.code)" class="d-block mb-2" :href="youtubeLocalhostHref" target="_blank" rel="noopener noreferrer">Bu sayfayı localhost adresinde aç</a>
                        <button v-if="youtubeError.retryable" class="btn btn-sm btn-secondary me-2 mb-1" @click="retryYoutube">Yeniden dene</button>
                        <router-link class="btn btn-sm btn-secondary me-2 mb-1" :to="`/tab/${tabID}/edit/audio`">Başka video veya ses seç</router-link>
                        <button class="btn btn-sm btn-outline-secondary mb-1" @click="audioSynth">Örnek seslere dön</button>
                    </div>
                </div>

                <!-- Audio Player -->
                <audio ref="audioPlayer" class="player" controls v-show='currentAudio.startsWith("audio-")' hidden></audio>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/vars.scss";

$toolbar-height: 60px;
$youtube-height: 200px;

// Light Score

.main {
    width: 95%;
    color: #d6d6d6;
    margin: 0 auto $toolbar-height auto;

    &.light {
        background-color: #f1f1f1;
        padding-top: 30px;

        h1,
        h2 {
            color: #333;
        }
    }
}

.yt-margin {
    width: 1px;
    height: $youtube-height !important;
}

.toolbar {
    backdrop-filter: blur(10px);
    border-bottom: 1px solid #3c3b40;
    position: fixed;
    bottom: 0;
    left: 0;
    width: 100%;
    z-index: 1000;

    .light & {
        background-color: rgba(33, 37, 41, 0.8);
    }

    &.auto-hide {
        transition: transform 0.3s;
        transform: translateY(calc(100% - 5px));

        &:hover {
            transform: translateY(0);
        }
    }

    // Allow horizontal scroll
    .scroll {
        padding: 8px 15px;
        display: flex;
        align-items: center;
        flex-grow: 4;
        column-gap: 10px;

        .btn-edit {
            flex-grow: 1;
            text-align: right;
        }

        .button,
        .btn {
            height: 44px;
            white-space: nowrap;
        }

        .btn-secondary {
            &.active {
                //background-color: lighten($primary, 10%);
            }
        }

        .close {
            cursor: pointer;
            &:hover {
                color: white;
            }
        }
    }

    .player-container {
        position: absolute;
        bottom: 100%;
        right: 0;
        display: flex;

        // align bottom
        align-items: flex-end;

        white-space: nowrap;

        .player {
            height: 200px;
        }

        .sync-offset {
            color: white;
            display: flex;
            align-items: center;
            background-color: $dark1;

            input {
                margin: 0 5px;
                background-color: #32393e;
                border: 1px solid #555b60;
                color: white;
            }
        }
    }
}

.youtube {
    margin-top: 20px;
}

.youtube-view {
    display: flex;
    flex-direction: column;
    align-items: flex-end;

    .player {
        height: 200px;
    }
}

.youtube-error {
    white-space: normal;
    width: min(420px, calc(100vw - 20px));
}

h1 {
    text-align: center;
    font-size: 45px;
    font-weight: 300;
    line-height: 45px;
    word-break: break-word;
}

h2 {
    text-align: center;
    margin-bottom: 0;
}

$color: #32393e;
$padding: 20px;

.selector {
    .button {
        cursor: pointer;
        padding: 10px 15px;
        border-radius: 3px;
        background-color: $color;
        user-select: none;
        transition: background-color 0.2s;
        white-space: nowrap;

        &:hover {
            background-color: lighten($color, 10%);
        }
    }
}

.list {
    position: absolute;
    background-color: $color;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(10px);
    border-radius: 3px;
    bottom: $toolbar-height;
    left: 15px;
    min-width: 400px;
    overflow: scroll;
    max-height: calc(100vh - 90px);

    // TODO: No matter how big it is, the tab cursor (z-index: 1000) is always on top of it for unknown reason.
    z-index: 1;

    .list-header {
        position: sticky;
        top: 0;
        background-color: $color;
        border-bottom: 1px solid darken($color, 5%);
    }

    .item {
        cursor: pointer;
        display: flex;
        align-items: center;
        border-bottom: 1px solid darken($color, 5%);

        &.active {
            background-color: lighten($color, 8%);
        }

        .name {
            flex-grow: 1;
            font-weight: bold;
            padding: $padding;
            height: 100%;
            border-right: 1px solid darken($color, 5%);

            &:hover {
                background-color: lighten($color, 2%);
            }
        }
    }
}

.track-list {
    .track {
        .list-button {
            background-color: lighten($color, 10%);
            border-right: 1px solid darken($color, 5%);
            padding: $padding;
            height: 100%;

            &:hover {
                background-color: lighten($primary, 5%);
            }

            &.active {
                background-color: lighten($primary, 8%);
            }
        }
    }
}

.audio-selector {
    position: relative;
}

.track-selector {
    position: relative;
}

.select-percentage {
    display: flex;
    align-items: center;
    gap: 4px;

    input {
        min-width: 90px;
        border: 0;
    }
}

.mobile {
    h1 {
        font-size: 20px;
    }

    h2 {
        font-size: 16px;
    }

    .list {
        width: 100%;
        left: 0;
    }

    .toolbar {
        .scroll {
            overflow-x: scroll;
        }

        .player-container {
            .sync-offset {
                display: none;
            }
        }
    }

    .speed {
        input {
            width: 100px;
        }
    }
}

.key-signature {
    position: absolute;
    margin-left: 30px;
}
</style>

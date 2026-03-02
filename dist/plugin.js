var capacitorAudioPlayer = (function (exports, core) {
    'use strict';

    const AudioPlayer = core.registerPlugin('AudioPlayer', {
        web: () => Promise.resolve().then(function () { return web; }).then(m => new m.AudioPlayerWeb()),
    });

    const DEFAULT_PLAYBACK_OPTIONS = {
        previousThresholdSeconds: 7,
        skipForwardSeconds: 10,
        skipBackwardSeconds: 10,
        enableNextPrev: true,
        enableSeekTo: true,
        enableSkipForwardBackward: true,
        enableStop: true,
    };
    const STATE_POLL_MS = 600;
    class AudioPlayerWeb extends core.WebPlugin {
        constructor() {
            super();
            this.items = [];
            this.currentIndex = 0;
            this.queueRevision = 0;
            this.stateRevision = 0;
            this.status = 'stopped';
            this.rate = 1;
            this.volumePercent = 100;
            this.repeatMode = 'off';
            this.shuffle = false;
            this.playbackOptions = Object.assign({}, DEFAULT_PLAYBACK_OPTIONS);
            this.progressMap = new Map();
            this.audio = null;
            this.statePollTimer = null;
            this.stateChangeListeners = [];
            this.trackChangeListeners = [];
            this.queueChangeListeners = [];
            this.metadataChangeListeners = [];
            this.audioBecomingNoisyListeners = [];
            this.ensureAudio();
        }
        ensureAudio() {
            if (this.audio)
                return this.audio;
            const audio = new Audio();
            audio.preload = 'auto';
            audio.addEventListener('ended', () => this.onAudioEnded());
            audio.addEventListener('play', () => this.setStatus('playing'));
            audio.addEventListener('pause', () => {
                if (audio.currentTime === 0 && !audio.src)
                    return;
                this.setStatus('paused');
            });
            audio.addEventListener('error', () => this.setStatus('stopped'));
            this.audio = audio;
            return audio;
        }
        setStatus(status) {
            if (this.status === status)
                return;
            this.status = status;
            this.emitStateChange();
            if (status === 'playing') {
                this.startStatePolling();
            }
            else {
                this.stopStatePolling();
            }
        }
        onAudioEnded() {
            var _a, _b;
            const item = this.items[this.currentIndex];
            if (!item) {
                this.setStatus('stopped');
                return;
            }
            if (this.repeatMode === 'one') {
                const audio = this.audio;
                if (audio) {
                    audio.currentTime = 0;
                    void audio.play();
                }
                return;
            }
            const hasNext = this.currentIndex < this.items.length - 1;
            if (this.repeatMode === 'all' && !hasNext && this.items.length > 0) {
                this.loadItemByIndex(0);
                this.emitTrackChange();
                void ((_a = this.audio) === null || _a === void 0 ? void 0 : _a.play());
                return;
            }
            if (hasNext) {
                this.loadItemByIndex(this.currentIndex + 1);
                this.emitTrackChange();
                void ((_b = this.audio) === null || _b === void 0 ? void 0 : _b.play());
            }
            else {
                this.setStatus('stopped');
            }
        }
        loadItemByIndex(index) {
            if (index < 0 || index >= this.items.length)
                return;
            this.currentIndex = index;
            const item = this.items[index];
            const audio = this.ensureAudio();
            audio.pause();
            audio.src = item.src;
            audio.load();
            this.updateMediaSessionMetadata(item);
            this.emitStateChange();
        }
        updateMediaSessionMetadata(item) {
            if (typeof navigator === 'undefined' || !navigator.mediaSession)
                return;
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: item.title || '',
                    artist: item.artist || '',
                    album: item.album || '',
                    artwork: item.artwork
                        ? [{ src: item.artwork, sizes: '512x512', type: 'image/png' }]
                        : [],
                });
            }
            catch (_a) {
                // ignore
            }
        }
        setupMediaSessionHandlers() {
            var _a, _b;
            if (typeof navigator === 'undefined' || !navigator.mediaSession)
                return;
            const opts = this.playbackOptions;
            try {
                navigator.mediaSession.setActionHandler('play', () => {
                    void this.play();
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    void this.pause();
                });
                if (opts.enableStop) {
                    navigator.mediaSession.setActionHandler('stop', () => {
                        void this.stop();
                    });
                }
                if (opts.enableSeekTo) {
                    navigator.mediaSession.setActionHandler('seekto', (details) => {
                        if (this.audio && typeof (details === null || details === void 0 ? void 0 : details.seekTime) === 'number') {
                            this.audio.currentTime = details.seekTime;
                            this.emitStateChange();
                        }
                    });
                }
                if (opts.enableSkipForwardBackward) {
                    const fwd = (_a = opts.skipForwardSeconds) !== null && _a !== void 0 ? _a : 10;
                    const bwd = (_b = opts.skipBackwardSeconds) !== null && _b !== void 0 ? _b : 10;
                    navigator.mediaSession.setActionHandler('seekforward', (details) => {
                        if (this.audio) {
                            const offset = typeof (details === null || details === void 0 ? void 0 : details.seekOffset) === 'number' ? details.seekOffset : fwd;
                            this.audio.currentTime = Math.min(this.audio.duration || Number.MAX_SAFE_INTEGER, this.audio.currentTime + offset);
                            this.emitStateChange();
                        }
                    });
                    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                        if (this.audio) {
                            const offset = typeof (details === null || details === void 0 ? void 0 : details.seekOffset) === 'number' ? details.seekOffset : bwd;
                            this.audio.currentTime = Math.max(0, this.audio.currentTime - offset);
                            this.emitStateChange();
                        }
                    });
                }
                if (opts.enableNextPrev) {
                    navigator.mediaSession.setActionHandler('nexttrack', () => {
                        void this.skipToNext();
                    });
                    navigator.mediaSession.setActionHandler('previoustrack', () => {
                        void this.skipToPrevious();
                    });
                }
            }
            catch (_c) {
                // some handlers may not be supported
            }
        }
        getPosition() {
            var _a, _b;
            return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.currentTime) !== null && _b !== void 0 ? _b : 0;
        }
        getDuration() {
            var _a, _b;
            const d = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.duration;
            if (d != null && isFinite(d))
                return d;
            const item = this.items[this.currentIndex];
            return (_b = item === null || item === void 0 ? void 0 : item.duration) !== null && _b !== void 0 ? _b : 0;
        }
        buildPlayerState() {
            var _a;
            return {
                stateRevision: this.stateRevision,
                queueRevision: this.queueRevision,
                status: this.status,
                currentIndex: this.currentIndex,
                currentItemId: (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id,
                position: this.getPosition(),
                duration: this.getDuration(),
                rate: this.rate,
                volume: this.volumePercent,
                repeatMode: this.repeatMode,
                shuffle: this.shuffle,
            };
        }
        emitStateChange() {
            this.stateRevision++;
            const state = this.buildPlayerState();
            this.stateChangeListeners.forEach((fn) => {
                try {
                    fn(state);
                }
                catch (_a) {
                    // ignore
                }
            });
        }
        emitTrackChange() {
            const item = this.items[this.currentIndex];
            if (!item)
                return;
            const event = {
                queueRevision: this.queueRevision,
                currentIndex: this.currentIndex,
                item,
            };
            this.trackChangeListeners.forEach((fn) => {
                try {
                    fn(event);
                }
                catch (_a) {
                    // ignore
                }
            });
        }
        emitQueueChange() {
            var _a;
            const event = {
                queueRevision: this.queueRevision,
                items: [...this.items],
                currentIndex: this.currentIndex,
                currentItemId: (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id,
            };
            this.queueChangeListeners.forEach((fn) => {
                try {
                    fn(event);
                }
                catch (_a) {
                    // ignore
                }
            });
        }
        startStatePolling() {
            if (this.statePollTimer)
                return;
            this.statePollTimer = setInterval(() => {
                if (this.status === 'playing')
                    this.emitStateChange();
            }, STATE_POLL_MS);
        }
        stopStatePolling() {
            if (this.statePollTimer) {
                clearInterval(this.statePollTimer);
                this.statePollTimer = null;
            }
        }
        createListenerHandle(listeners, fn) {
            listeners.push(fn);
            return {
                remove: async () => {
                    const i = listeners.indexOf(fn);
                    if (i !== -1)
                        listeners.splice(i, 1);
                },
            };
        }
        // --- Queue ---
        async setQueue(params) {
            var _a, _b;
            this.items = ((_a = params.items) === null || _a === void 0 ? void 0 : _a.length) ? [...params.items] : [];
            this.queueRevision++;
            const startIndex = Math.min((_b = params.startIndex) !== null && _b !== void 0 ? _b : 0, Math.max(0, this.items.length - 1));
            this.currentIndex = startIndex;
            const audio = this.ensureAudio();
            audio.pause();
            if (this.items.length) {
                const item = this.items[this.currentIndex];
                audio.src = item.src;
                audio.load();
                if (params.startPositionSeconds != null && params.startPositionSeconds > 0) {
                    audio.currentTime = params.startPositionSeconds;
                }
                this.updateMediaSessionMetadata(item);
                this.setupMediaSessionHandlers();
                if (params.autoplay) {
                    this.setStatus('playing');
                    void audio.play();
                }
                else {
                    this.setStatus('stopped');
                }
            }
            else {
                audio.src = '';
                this.setStatus('stopped');
            }
            this.emitStateChange();
            this.emitQueueChange();
        }
        async syncQueue(params) {
            if (params.mode === 'replace') {
                await this.setQueue(params);
                return { queueRevision: this.queueRevision };
            }
            if (params.mode === 'patch' && params.expectedQueueRevision === this.queueRevision) {
                await this.setQueue(params);
                return { queueRevision: this.queueRevision };
            }
            return { queueRevision: this.queueRevision };
        }
        async getQueue() {
            var _a;
            return {
                queueRevision: this.queueRevision,
                items: [...this.items],
                currentIndex: this.currentIndex,
                currentItemId: (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id,
            };
        }
        async addQueueItems(params) {
            var _a, _b, _c;
            const beforeLength = this.items.length;
            const beforeCurrentItemId = (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id;
            const insertItems = (_b = params.items) !== null && _b !== void 0 ? _b : [];
            const atRaw = (_c = params.atIndex) !== null && _c !== void 0 ? _c : this.items.length;
            const at = Math.max(0, Math.min(atRaw, this.items.length));
            this.items.splice(at, 0, ...insertItems);
            // Keep pointing at the same current item when inserting at/before it.
            if (beforeLength > 0 && beforeCurrentItemId && at <= this.currentIndex) {
                this.currentIndex += insertItems.length;
            }
            // If queue was empty and now has items, initialize the current item (without autoplay).
            if (beforeLength === 0 && this.items.length > 0) {
                this.currentIndex = 0;
                this.loadItemByIndex(0);
                this.setStatus('stopped');
            }
            this.queueRevision++;
            this.emitQueueChange();
            this.emitStateChange();
        }
        async removeQueueItem(params) {
            var _a, _b, _c;
            const statusBefore = this.status;
            const beforeCurrentItemId = (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id;
            const i = this.items.findIndex((x) => x.id === params.itemId);
            if (i === -1)
                return;
            this.items.splice(i, 1);
            this.queueRevision++;
            // Keep currentIndex pointing at the same logical item where possible.
            if (i === this.currentIndex) {
                // Current item removed: keep the same numeric index to play the next item (or clamp to last).
                if (this.items.length === 0) {
                    if (this.audio) {
                        this.audio.pause();
                        this.audio.src = '';
                    }
                    this.currentIndex = 0;
                    this.setStatus('stopped');
                }
                else {
                    this.currentIndex = Math.min(this.currentIndex, this.items.length - 1);
                    this.loadItemByIndex(this.currentIndex);
                    this.setStatus(statusBefore);
                    if (statusBefore === 'playing') {
                        void ((_b = this.audio) === null || _b === void 0 ? void 0 : _b.play());
                    }
                }
            }
            else if (this.currentIndex >= this.items.length) {
                this.currentIndex = Math.max(0, this.items.length - 1);
                if (this.items.length) {
                    this.loadItemByIndex(this.currentIndex);
                }
                else {
                    if (this.audio) {
                        this.audio.pause();
                        this.audio.src = '';
                    }
                    this.setStatus('stopped');
                }
            }
            else if (this.currentIndex > i) {
                this.currentIndex--;
            }
            const afterCurrentItemId = (_c = this.items[this.currentIndex]) === null || _c === void 0 ? void 0 : _c.id;
            if (beforeCurrentItemId && afterCurrentItemId && beforeCurrentItemId !== afterCurrentItemId) {
                this.emitTrackChange();
            }
            this.emitQueueChange();
            this.emitStateChange();
        }
        async moveQueueItem(params) {
            const { fromIndex, toIndex } = params;
            if (fromIndex < 0 || fromIndex >= this.items.length || toIndex < 0 || toIndex >= this.items.length)
                return;
            const [item] = this.items.splice(fromIndex, 1);
            this.items.splice(toIndex, 0, item);
            this.queueRevision++;
            if (this.currentIndex === fromIndex) {
                this.currentIndex = toIndex;
            }
            else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
                this.currentIndex--;
            }
            else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
                this.currentIndex++;
            }
            this.emitQueueChange();
            this.emitStateChange();
        }
        async clearQueue() {
            this.items = [];
            this.currentIndex = 0;
            this.queueRevision++;
            const audio = this.audio;
            if (audio) {
                audio.pause();
                audio.src = '';
            }
            this.setStatus('stopped');
            this.emitQueueChange();
            this.emitStateChange();
        }
        // --- Playback ---
        async play() {
            const audio = this.ensureAudio();
            if (this.items.length && !audio.src) {
                const item = this.items[this.currentIndex];
                if (item) {
                    audio.src = item.src;
                    audio.load();
                    this.updateMediaSessionMetadata(item);
                }
            }
            this.setStatus('playing');
            await audio.play();
        }
        async pause() {
            var _a;
            (_a = this.audio) === null || _a === void 0 ? void 0 : _a.pause();
            this.setStatus('paused');
        }
        async stop() {
            const audio = this.audio;
            if (audio) {
                audio.pause();
                audio.currentTime = 0;
            }
            this.setStatus('stopped');
            this.emitStateChange();
        }
        async seek(params) {
            const audio = this.audio;
            if (!audio)
                return;
            audio.currentTime = Math.max(0, params.positionSeconds);
            this.emitStateChange();
        }
        async skipToNext() {
            var _a;
            if (this.items.length === 0)
                return;
            const nextIndex = this.currentIndex < this.items.length - 1
                ? this.currentIndex + 1
                : this.repeatMode === 'all'
                    ? 0
                    : this.currentIndex;
            if (nextIndex !== this.currentIndex) {
                this.loadItemByIndex(nextIndex);
                this.emitTrackChange();
                if (this.status === 'playing')
                    void ((_a = this.audio) === null || _a === void 0 ? void 0 : _a.play());
            }
        }
        async skipToPrevious() {
            var _a, _b, _c;
            if (this.items.length === 0)
                return;
            const audio = this.audio;
            const threshold = (_a = this.playbackOptions.previousThresholdSeconds) !== null && _a !== void 0 ? _a : 7;
            const atStart = ((_b = audio === null || audio === void 0 ? void 0 : audio.currentTime) !== null && _b !== void 0 ? _b : 0) <= threshold;
            const prevIndex = atStart && this.currentIndex > 0
                ? this.currentIndex - 1
                : this.currentIndex;
            if (prevIndex < this.currentIndex) {
                this.loadItemByIndex(prevIndex);
                this.emitTrackChange();
                if (this.status === 'playing')
                    void ((_c = this.audio) === null || _c === void 0 ? void 0 : _c.play());
            }
            else if (audio) {
                audio.currentTime = 0;
                this.emitStateChange();
            }
        }
        async skipToIndex(params) {
            var _a;
            const index = Math.max(0, Math.min(params.index, this.items.length - 1));
            if (index === this.currentIndex) {
                if (params.positionSeconds != null && this.audio) {
                    this.audio.currentTime = params.positionSeconds;
                    this.emitStateChange();
                }
                return;
            }
            this.loadItemByIndex(index);
            if (params.positionSeconds != null && this.audio) {
                this.audio.currentTime = params.positionSeconds;
            }
            this.emitTrackChange();
            if (this.status === 'playing')
                void ((_a = this.audio) === null || _a === void 0 ? void 0 : _a.play());
        }
        async setRate(params) {
            this.rate = Math.max(0.5, Math.min(2, params.rate));
            if (this.audio)
                this.audio.playbackRate = this.rate;
            this.emitStateChange();
        }
        async setVolume(params) {
            this.volumePercent = Math.max(0, Math.min(100, params.volume));
            if (this.audio)
                this.audio.volume = this.volumePercent / 100;
            this.emitStateChange();
        }
        // --- State ---
        async getState() {
            return this.buildPlayerState();
        }
        // --- Progress / bookmarks (in-memory on web) ---
        async setItemProgress(params) {
            const progress = {
                itemId: params.itemId,
                positionSeconds: params.positionSeconds,
                durationSeconds: params.durationSeconds,
                completed: params.completed,
                updatedAtEpochMs: Date.now(),
            };
            this.progressMap.set(params.itemId, progress);
        }
        async getItemProgress(params) {
            var _a;
            const stored = this.progressMap.get(params.itemId);
            if (stored)
                return stored;
            const item = this.items.find((x) => x.id === params.itemId);
            const pos = item && ((_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id) === params.itemId ? this.getPosition() : 0;
            const dur = item === null || item === void 0 ? void 0 : item.duration;
            return {
                itemId: params.itemId,
                positionSeconds: pos,
                durationSeconds: dur,
                completed: false,
                updatedAtEpochMs: Date.now(),
            };
        }
        // --- Options ---
        async setPlaybackOptions(params) {
            this.playbackOptions = Object.assign(Object.assign(Object.assign({}, DEFAULT_PLAYBACK_OPTIONS), this.playbackOptions), params);
            this.setupMediaSessionHandlers();
        }
        async getPlaybackOptions() {
            return Object.assign({}, this.playbackOptions);
        }
        async setRepeatMode(params) {
            this.repeatMode = params.repeatMode;
            this.emitStateChange();
        }
        async setShuffle(params) {
            this.shuffle = params.shuffle;
            this.emitStateChange();
        }
        async addListener(eventName, listenerFunc) {
            if (eventName === 'stateChange') {
                return this.createListenerHandle(this.stateChangeListeners, listenerFunc);
            }
            if (eventName === 'trackChange') {
                return this.createListenerHandle(this.trackChangeListeners, listenerFunc);
            }
            if (eventName === 'queueChange') {
                return this.createListenerHandle(this.queueChangeListeners, listenerFunc);
            }
            if (eventName === 'metadataChange') {
                return this.createListenerHandle(this.metadataChangeListeners, listenerFunc);
            }
            if (eventName === 'audioBecomingNoisy') {
                return this.createListenerHandle(this.audioBecomingNoisyListeners, listenerFunc);
            }
            return Promise.reject(new Error(`Unknown event: ${eventName}`));
        }
        async removeAllListeners() {
            this.stateChangeListeners = [];
            this.trackChangeListeners = [];
            this.queueChangeListeners = [];
            this.metadataChangeListeners = [];
            this.audioBecomingNoisyListeners = [];
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        AudioPlayerWeb: AudioPlayerWeb
    });

    exports.AudioPlayer = AudioPlayer;

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map

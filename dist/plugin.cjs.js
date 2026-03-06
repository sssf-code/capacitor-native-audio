'use strict';

var core = require('@capacitor/core');

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
    autoplayNext: true,
};
class AudioPlayerWeb extends core.WebPlugin {
    constructor() {
        super(...arguments);
        this.audio = null;
        this.queue = [];
        this.currentIndex = 0;
        this.stateRevision = 0;
        this.queueRevision = 0;
        this.status = 'stopped';
        this.rate = 1;
        this.volume = 100; // 0..100
        this.repeatMode = 'off';
        this.shuffle = false;
        this.playbackOptions = Object.assign({}, DEFAULT_PLAYBACK_OPTIONS);
        this.progress = new Map();
    }
    ensureAudio() {
        if (this.audio) {
            return this.audio;
        }
        const audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('timeupdate', () => {
            if (!this.audio) {
                return;
            }
            this.notifyStateFromElement();
        });
        audio.addEventListener('loadedmetadata', () => {
            if (!this.audio) {
                return;
            }
            this.notifyStateFromElement();
        });
        audio.addEventListener('ended', () => {
            this.handleEnded();
        });
        audio.addEventListener('play', () => {
            this.status = 'playing';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        });
        audio.addEventListener('pause', () => {
            if (this.status === 'stopped') {
                return;
            }
            this.status = 'paused';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        });
        this.audio = audio;
        return audio;
    }
    bumpStateRevision() {
        this.stateRevision += 1;
    }
    bumpQueueRevision() {
        this.queueRevision += 1;
    }
    getCurrentItem() {
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            return undefined;
        }
        return this.queue[this.currentIndex];
    }
    updateMediaSessionMetadata(item) {
        var _a, _b, _c;
        if (typeof navigator === 'undefined') {
            return;
        }
        const anyNavigator = navigator;
        if (!anyNavigator.mediaSession) {
            return;
        }
        if (!item) {
            anyNavigator.mediaSession.metadata = null;
            return;
        }
        try {
            anyNavigator.mediaSession.metadata = new MediaMetadata({
                title: (_a = item.title) !== null && _a !== void 0 ? _a : '',
                artist: (_b = item.artist) !== null && _b !== void 0 ? _b : '',
                album: (_c = item.album) !== null && _c !== void 0 ? _c : '',
                artwork: item.artwork
                    ? [
                        {
                            src: item.artwork,
                            sizes: '512x512',
                            type: 'image/png',
                        },
                    ]
                    : [],
            });
            anyNavigator.mediaSession.setActionHandler('play', async () => {
                await this.play();
            });
            anyNavigator.mediaSession.setActionHandler('pause', async () => {
                await this.pause();
            });
            anyNavigator.mediaSession.setActionHandler('stop', async () => {
                await this.stop();
            });
            anyNavigator.mediaSession.setActionHandler('seekto', async (details) => {
                if (typeof details.seekTime === 'number') {
                    await this.seek({ positionSeconds: details.seekTime });
                }
            });
            anyNavigator.mediaSession.setActionHandler('seekbackward', async (details) => {
                const offset = typeof details.seekOffset === 'number'
                    ? details.seekOffset
                    : this.playbackOptions.skipBackwardSeconds;
                const state = await this.getState();
                const target = Math.max(0, state.position - offset);
                await this.seek({ positionSeconds: target });
            });
            anyNavigator.mediaSession.setActionHandler('seekforward', async (details) => {
                var _a;
                const offset = typeof details.seekOffset === 'number'
                    ? details.seekOffset
                    : this.playbackOptions.skipForwardSeconds;
                const state = await this.getState();
                const duration = (_a = state.duration) !== null && _a !== void 0 ? _a : Number.MAX_SAFE_INTEGER;
                const target = Math.min(duration, state.position + offset);
                await this.seek({ positionSeconds: target });
            });
            anyNavigator.mediaSession.setActionHandler('previoustrack', async () => {
                await this.skipToPrevious();
            });
            anyNavigator.mediaSession.setActionHandler('nexttrack', async () => {
                await this.skipToNext();
            });
        }
        catch (_d) {
            // Media Session is best-effort only
        }
    }
    async loadCurrent(autoplay, startPositionSeconds) {
        const item = this.getCurrentItem();
        if (!item) {
            return;
        }
        const audio = this.ensureAudio();
        audio.pause();
        audio.currentTime = 0;
        audio.src = item.src;
        audio.playbackRate = this.rate;
        audio.volume = this.volume / 100;
        this.updateMediaSessionMetadata(item);
        await new Promise((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('Failed to load audio source'));
            };
            const cleanup = () => {
                audio.removeEventListener('loadedmetadata', onReady);
                audio.removeEventListener('canplay', onReady);
                audio.removeEventListener('error', onError);
            };
            audio.addEventListener('loadedmetadata', onReady, { once: true });
            audio.addEventListener('canplay', onReady, { once: true });
            audio.addEventListener('error', onError, { once: true });
            try {
                audio.load();
            }
            catch (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
        if (typeof startPositionSeconds === 'number' && startPositionSeconds > 0) {
            audio.currentTime = startPositionSeconds;
        }
        this.notifyStateFromElement();
        if (autoplay) {
            await audio.play();
            this.status = 'playing';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        }
        else {
            this.status = 'paused';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        }
        this.notifyListeners('trackChange', {
            queueRevision: this.queueRevision,
            currentIndex: this.currentIndex,
            item,
        });
    }
    handleEnded() {
        var _a, _b, _c;
        const item = this.getCurrentItem();
        const now = Date.now();
        if (item) {
            const existing = this.progress.get(item.id);
            const durationSeconds = (_c = (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.duration) !== null && _b !== void 0 ? _b : existing === null || existing === void 0 ? void 0 : existing.durationSeconds) !== null && _c !== void 0 ? _c : 0;
            this.progress.set(item.id, {
                itemId: item.id,
                positionSeconds: durationSeconds,
                durationSeconds,
                completed: true,
                updatedAtEpochMs: now,
            });
        }
        if (this.repeatMode === 'one' && this.playbackOptions.autoplayNext !== false) {
            void this.seek({ positionSeconds: 0 }).then(() => this.play());
            return;
        }
        const lastIndex = this.queue.length - 1;
        // When autoplayNext is disabled, do not advance in the queue or repeat;
        // pause/stop at the end of the current item and keep the session active.
        if (this.playbackOptions.autoplayNext === false) {
            this.status = 'stopped';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
            return;
        }
        if (this.currentIndex < lastIndex) {
            void this.skipToNext();
            return;
        }
        if (this.repeatMode === 'all' && this.queue.length > 0) {
            this.currentIndex = 0;
            void this.loadCurrent(true, 0);
            return;
        }
        this.status = 'stopped';
        this.bumpStateRevision();
        this.notifyListeners('stateChange', this.buildState());
    }
    notifyStateFromElement() {
        if (!this.audio) {
            return;
        }
        this.bumpStateRevision();
        this.notifyListeners('stateChange', this.buildState());
    }
    buildState() {
        var _a, _b;
        const audio = this.audio;
        const position = (_a = audio === null || audio === void 0 ? void 0 : audio.currentTime) !== null && _a !== void 0 ? _a : 0;
        const duration = audio === null || audio === void 0 ? void 0 : audio.duration;
        return {
            stateRevision: this.stateRevision,
            queueRevision: this.queueRevision,
            status: this.status,
            currentIndex: this.currentIndex,
            currentItemId: (_b = this.getCurrentItem()) === null || _b === void 0 ? void 0 : _b.id,
            position,
            duration: Number.isFinite(duration !== null && duration !== void 0 ? duration : NaN) ? duration : undefined,
            rate: this.rate,
            volume: this.volume,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle,
        };
    }
    // Queue
    async setQueue(params) {
        const { items, startIndex = 0, startPositionSeconds = 0, autoplay } = params;
        this.queue = [...items];
        this.currentIndex = Math.max(0, Math.min(startIndex, this.queue.length - 1));
        this.bumpQueueRevision();
        await this.loadCurrent(autoplay !== null && autoplay !== void 0 ? autoplay : false, startPositionSeconds);
    }
    async syncQueue(params) {
        // For now, treat all modes as full replace. This matches how the app uses the plugin.
        await this.setQueue(params);
        return { queueRevision: this.queueRevision };
    }
    async getQueue() {
        var _a;
        return {
            queueRevision: this.queueRevision,
            items: [...this.queue],
            currentIndex: this.currentIndex,
            currentItemId: (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id,
        };
    }
    async addQueueItems(params) {
        const { items, atIndex } = params;
        if (typeof atIndex === 'number' && atIndex >= 0 && atIndex <= this.queue.length) {
            this.queue.splice(atIndex, 0, ...items);
            if (this.currentIndex >= atIndex) {
                this.currentIndex += items.length;
            }
        }
        else {
            this.queue.push(...items);
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }
    async removeQueueItem(params) {
        const idx = this.queue.findIndex(it => it.id === params.itemId);
        if (idx === -1) {
            return;
        }
        this.queue.splice(idx, 1);
        if (this.currentIndex > idx) {
            this.currentIndex -= 1;
        }
        else if (this.currentIndex === idx) {
            this.currentIndex = Math.min(this.currentIndex, this.queue.length - 1);
            if (this.queue.length === 0) {
                await this.stop();
            }
            else {
                await this.loadCurrent(false, 0);
            }
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }
    async moveQueueItem(params) {
        const { fromIndex, toIndex } = params;
        if (fromIndex < 0 ||
            fromIndex >= this.queue.length ||
            toIndex < 0 ||
            toIndex >= this.queue.length) {
            return;
        }
        const [item] = this.queue.splice(fromIndex, 1);
        this.queue.splice(toIndex, 0, item);
        if (this.currentIndex === fromIndex) {
            this.currentIndex = toIndex;
        }
        else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
            this.currentIndex -= 1;
        }
        else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
            this.currentIndex += 1;
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }
    async clearQueue() {
        if (this.audio) {
            this.audio.pause();
            this.audio.currentTime = 0;
            this.audio.src = '';
        }
        this.queue = [];
        this.currentIndex = 0;
        this.status = 'stopped';
        this.bumpQueueRevision();
        this.bumpStateRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
        await this.notifyListeners('stateChange', this.buildState());
    }
    // Playback
    async play() {
        if (!this.getCurrentItem() && this.queue.length > 0) {
            this.currentIndex = 0;
            await this.loadCurrent(false, 0);
        }
        const audio = this.ensureAudio();
        try {
            await audio.play();
        }
        catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        this.status = 'playing';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }
    async pause() {
        if (!this.audio) {
            return;
        }
        this.audio.pause();
        this.status = 'paused';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }
    async stop() {
        if (!this.audio) {
            return;
        }
        this.audio.pause();
        this.audio.currentTime = 0;
        this.status = 'stopped';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }
    async seek(params) {
        const audio = this.ensureAudio();
        const target = Math.max(0, params.positionSeconds);
        try {
            audio.currentTime = target;
        }
        catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        this.notifyStateFromElement();
    }
    async skipToPreviousInternal() {
        const state = await this.getState();
        const threshold = this.playbackOptions.previousThresholdSeconds;
        if (state.position > threshold) {
            await this.seek({ positionSeconds: 0 });
            return;
        }
        if (this.currentIndex <= 0) {
            await this.seek({ positionSeconds: 0 });
            return;
        }
        this.currentIndex -= 1;
        await this.loadCurrent(true, 0);
    }
    async skipToNext() {
        if (this.currentIndex >= this.queue.length - 1) {
            await this.stop();
            return;
        }
        this.currentIndex += 1;
        await this.loadCurrent(true, 0);
    }
    // Methods required by the interface
    async skipToPrevious() {
        await this.skipToPreviousInternal();
    }
    async skipToIndex(params) {
        var _a;
        const index = Math.max(0, Math.min(params.index, this.queue.length - 1));
        this.currentIndex = index;
        await this.loadCurrent(true, (_a = params.positionSeconds) !== null && _a !== void 0 ? _a : 0);
    }
    async setRate(params) {
        const clamped = Math.max(0.5, Math.min(2, params.rate));
        this.rate = clamped;
        if (this.audio) {
            this.audio.playbackRate = clamped;
        }
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }
    async setVolume(params) {
        const vol = Math.max(0, Math.min(100, params.volume));
        this.volume = vol;
        if (this.audio) {
            this.audio.volume = vol / 100;
        }
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }
    async getState() {
        return this.buildState();
    }
    // Progress / bookmarks
    setItemProgress(params) {
        const now = Date.now();
        this.progress.set(params.itemId, {
            itemId: params.itemId,
            positionSeconds: params.positionSeconds,
            durationSeconds: params.durationSeconds,
            completed: params.completed,
            updatedAtEpochMs: now,
        });
        return Promise.resolve();
    }
    getItemProgress(params) {
        const existing = this.progress.get(params.itemId);
        if (existing) {
            return Promise.resolve(existing);
        }
        return Promise.resolve({
            itemId: params.itemId,
            positionSeconds: 0,
            durationSeconds: undefined,
            completed: false,
            updatedAtEpochMs: Date.now(),
        });
    }
    // Options
    setPlaybackOptions(params) {
        this.playbackOptions = Object.assign(Object.assign({}, this.playbackOptions), params);
        return Promise.resolve();
    }
    getPlaybackOptions() {
        return Promise.resolve(this.playbackOptions);
    }
    // Playback modes
    setRepeatMode(params) {
        this.repeatMode = params.repeatMode;
        return Promise.resolve();
    }
    setShuffle(params) {
        this.shuffle = params.shuffle;
        return Promise.resolve();
    }
}

var web = /*#__PURE__*/Object.freeze({
    __proto__: null,
    AudioPlayerWeb: AudioPlayerWeb
});

exports.AudioPlayer = AudioPlayer;
//# sourceMappingURL=plugin.cjs.js.map

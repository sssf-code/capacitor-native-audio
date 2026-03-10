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
};
class AudioPlayerWeb extends core.WebPlugin {
    constructor() {
        super(...arguments);
        this.audio = null;
        this.baseQueue = [];
        this.shuffleQueue = null;
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
        this.suppressElementPlaybackEvents = 0;
        this.loadGeneration = 0;
        this.loadedItemId = null;
        this.metadataPollTimer = null;
        this.metadataPollGeneration = 0;
        this.metadataPollInFlight = null;
        this.metadataFingerprintByItemId = new Map();
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
            this.emitPassiveStateSnapshot();
        });
        audio.addEventListener('loadedmetadata', () => {
            if (!this.audio) {
                return;
            }
            this.emitPassiveStateSnapshot();
        });
        audio.addEventListener('durationchange', () => {
            if (!this.audio) {
                return;
            }
            this.emitPassiveStateSnapshot();
        });
        audio.addEventListener('ended', () => {
            void this.handleEnded();
        });
        audio.addEventListener('play', () => {
            if (!this.audio || this.suppressElementPlaybackEvents > 0) {
                return;
            }
            this.status = 'playing';
            this.startMetadataPollingIfNeeded();
            void this.emitStateChange();
        });
        audio.addEventListener('pause', () => {
            if (!this.audio ||
                this.suppressElementPlaybackEvents > 0 ||
                this.status === 'stopped') {
                return;
            }
            this.status = 'paused';
            this.stopMetadataPolling();
            void this.emitStateChange();
        });
        this.audio = audio;
        this.updateMediaSessionHandlers();
        return audio;
    }
    getMediaSession() {
        if (typeof navigator === 'undefined') {
            return undefined;
        }
        return navigator.mediaSession;
    }
    bumpStateRevision() {
        this.stateRevision += 1;
    }
    bumpQueueRevision() {
        this.queueRevision += 1;
        this.stateRevision += 1;
    }
    getCurrentItem() {
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            return undefined;
        }
        return this.queue[this.currentIndex];
    }
    getCurrentPosition() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.currentTime) !== null && _b !== void 0 ? _b : 0;
    }
    getCurrentDuration() {
        var _a;
        const duration = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.duration;
        return Number.isFinite(duration !== null && duration !== void 0 ? duration : NaN) ? duration : undefined;
    }
    getInactiveStatusAfterLoad(previousStatus) {
        return previousStatus === 'paused' ? 'paused' : 'stopped';
    }
    isCurrentItemLoaded() {
        const currentItem = this.getCurrentItem();
        return !!currentItem && this.loadedItemId === currentItem.id && !!this.audio;
    }
    async withSuppressedElementPlaybackEvents(fn) {
        this.suppressElementPlaybackEvents += 1;
        try {
            return await fn();
        }
        finally {
            this.suppressElementPlaybackEvents -= 1;
        }
    }
    buildInitialShuffleQueue(base, currentItemId) {
        var _a;
        if (base.length < 2) {
            return [...base];
        }
        const currentId = currentItemId !== null && currentItemId !== void 0 ? currentItemId : (_a = base[0]) === null || _a === void 0 ? void 0 : _a.id;
        const currentIndex = currentId
            ? Math.max(0, base.findIndex(item => item.id === currentId))
            : 0;
        const resolvedIndex = currentIndex >= 0 && currentIndex < base.length ? currentIndex : 0;
        const prefix = base.slice(0, resolvedIndex + 1);
        const tail = base.slice(resolvedIndex + 1);
        for (let idx = tail.length - 1; idx > 0; idx -= 1) {
            const swapIdx = Math.floor(Math.random() * (idx + 1));
            [tail[idx], tail[swapIdx]] = [tail[swapIdx], tail[idx]];
        }
        return [...prefix, ...tail];
    }
    rebuildShuffleQueueAfterBaseChange(currentItemId) {
        var _a, _b;
        if (!this.shuffle || this.baseQueue.length < 2) {
            return [...this.baseQueue];
        }
        const desiredId = currentItemId !== null && currentItemId !== void 0 ? currentItemId : (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id;
        const baseById = new Map(this.baseQueue.map(item => [item.id, item]));
        const existing = (_b = this.shuffleQueue) !== null && _b !== void 0 ? _b : this.queue;
        const prefixIds = [];
        if (desiredId) {
            const currentIdx = existing.findIndex(item => item.id === desiredId);
            if (currentIdx !== -1) {
                prefixIds.push(...existing
                    .slice(0, currentIdx + 1)
                    .map(item => item.id)
                    .filter(id => baseById.has(id)));
            }
        }
        const prefixItems = prefixIds
            .map(id => baseById.get(id))
            .filter((item) => !!item);
        const remaining = this.baseQueue.filter(item => !prefixIds.includes(item.id));
        for (let idx = remaining.length - 1; idx > 0; idx -= 1) {
            const swapIdx = Math.floor(Math.random() * (idx + 1));
            [remaining[idx], remaining[swapIdx]] = [remaining[swapIdx], remaining[idx]];
        }
        return [...prefixItems, ...remaining];
    }
    updateEffectiveQueue(desiredCurrentItemId, preserveExistingShufflePrefix = false) {
        var _a;
        if (!this.shuffle) {
            this.shuffleQueue = null;
            this.queue = [...this.baseQueue];
            return;
        }
        this.shuffleQueue = preserveExistingShufflePrefix
            ? this.rebuildShuffleQueueAfterBaseChange(desiredCurrentItemId)
            : this.buildInitialShuffleQueue(this.baseQueue, desiredCurrentItemId);
        this.queue = [...((_a = this.shuffleQueue) !== null && _a !== void 0 ? _a : this.baseQueue)];
    }
    resolveQueueIndex(desiredItemId, desiredIndex) {
        if (desiredItemId) {
            const idx = this.queue.findIndex(item => item.id === desiredItemId);
            if (idx !== -1) {
                return idx;
            }
        }
        if (this.queue.length === 0) {
            return 0;
        }
        const fallback = desiredIndex !== null && desiredIndex !== void 0 ? desiredIndex : 0;
        return Math.max(0, Math.min(fallback, this.queue.length - 1));
    }
    updateMediaSessionMetadata(item) {
        var _a, _b, _c;
        const session = this.getMediaSession();
        if (!session) {
            return;
        }
        try {
            if (!item) {
                session.metadata = null;
                return;
            }
            session.metadata = new MediaMetadata({
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
        }
        catch (_d) {
            // Media Session is best-effort only
        }
    }
    updateMediaSessionPlaybackState() {
        const session = this.getMediaSession();
        if (!session) {
            return;
        }
        try {
            session.playbackState =
                this.status === 'playing'
                    ? 'playing'
                    : this.status === 'paused'
                        ? 'paused'
                        : 'none';
        }
        catch (_a) {
            // Media Session is best-effort only
        }
    }
    updateMediaSessionPositionState() {
        const session = this.getMediaSession();
        if (!session || typeof session.setPositionState !== 'function') {
            return;
        }
        try {
            const item = this.getCurrentItem();
            const duration = this.getCurrentDuration();
            if (!item || !this.audio || !duration || duration <= 0) {
                session.setPositionState();
                return;
            }
            session.setPositionState({
                duration,
                playbackRate: this.rate,
                position: Math.max(0, Math.min(this.audio.currentTime, duration)),
            });
        }
        catch (_a) {
            // Media Session is best-effort only
        }
    }
    refreshMediaSessionState() {
        this.updateMediaSessionMetadata(this.getCurrentItem());
        this.updateMediaSessionPlaybackState();
        this.updateMediaSessionPositionState();
    }
    updateMediaSessionHandlers(mediaSession) {
        const session = mediaSession !== null && mediaSession !== void 0 ? mediaSession : this.getMediaSession();
        if (!session) {
            return;
        }
        const opts = this.playbackOptions;
        try {
            session.setActionHandler('play', async () => {
                await this.play();
            });
            session.setActionHandler('pause', async () => {
                await this.pause();
            });
            if (opts.enableStop === false) {
                session.setActionHandler('stop', null);
            }
            else {
                session.setActionHandler('stop', async () => {
                    await this.stop();
                });
            }
            if (opts.enableSeekTo === false) {
                session.setActionHandler('seekto', null);
            }
            else {
                session.setActionHandler('seekto', async (details) => {
                    if (typeof details.seekTime === 'number') {
                        await this.seek({ positionSeconds: details.seekTime });
                    }
                });
            }
            if (opts.enableSkipForwardBackward === false) {
                session.setActionHandler('seekbackward', null);
                session.setActionHandler('seekforward', null);
            }
            else {
                session.setActionHandler('seekbackward', async (details) => {
                    const offset = typeof details.seekOffset === 'number'
                        ? details.seekOffset
                        : this.playbackOptions.skipBackwardSeconds;
                    const target = Math.max(0, this.getCurrentPosition() - offset);
                    await this.seek({ positionSeconds: target });
                });
                session.setActionHandler('seekforward', async (details) => {
                    var _a;
                    const offset = typeof details.seekOffset === 'number'
                        ? details.seekOffset
                        : this.playbackOptions.skipForwardSeconds;
                    const duration = (_a = this.getCurrentDuration()) !== null && _a !== void 0 ? _a : Number.MAX_SAFE_INTEGER;
                    const target = Math.min(duration, this.getCurrentPosition() + offset);
                    await this.seek({ positionSeconds: target });
                });
            }
            if (opts.enableNextPrev === false) {
                session.setActionHandler('previoustrack', null);
                session.setActionHandler('nexttrack', null);
            }
            else {
                session.setActionHandler('previoustrack', async () => {
                    await this.skipToPrevious();
                });
                session.setActionHandler('nexttrack', async () => {
                    await this.skipToNext();
                });
            }
        }
        catch (_a) {
            // Media Session is best-effort only
        }
    }
    async emitStateChange(bumpRevision = true) {
        if (bumpRevision) {
            this.bumpStateRevision();
        }
        this.updateMediaSessionPlaybackState();
        this.updateMediaSessionPositionState();
        await this.notifyListeners('stateChange', this.buildState());
    }
    emitPassiveStateSnapshot() {
        if (!this.audio) {
            return;
        }
        this.updateMediaSessionPositionState();
    }
    async emitTrackChange() {
        const item = this.getCurrentItem();
        if (!item) {
            return;
        }
        await this.notifyListeners('trackChange', {
            queueRevision: this.queueRevision,
            currentIndex: this.currentIndex,
            item,
        });
    }
    async emitQueueChange() {
        await this.notifyListeners('queueChange', await this.getQueue());
    }
    async resetAudioForEmptyQueue() {
        this.stopMetadataPolling();
        this.loadGeneration += 1;
        this.loadedItemId = null;
        if (!this.audio) {
            this.refreshMediaSessionState();
            return;
        }
        await this.withSuppressedElementPlaybackEvents(async () => {
            var _a;
            (_a = this.audio) === null || _a === void 0 ? void 0 : _a.pause();
            if (this.audio) {
                this.audio.currentTime = 0;
                this.audio.removeAttribute('src');
                this.audio.load();
            }
        });
        this.refreshMediaSessionState();
    }
    async resetQueueState() {
        this.baseQueue = [];
        this.shuffleQueue = null;
        this.queue = [];
        this.currentIndex = 0;
        this.status = 'stopped';
        this.metadataFingerprintByItemId.clear();
        await this.resetAudioForEmptyQueue();
        this.bumpQueueRevision();
        await this.emitQueueChange();
        await this.emitStateChange(false);
    }
    syncAudioSettings() {
        if (!this.audio) {
            return;
        }
        this.audio.playbackRate = this.rate;
        this.audio.volume = this.volume / 100;
        this.updateMediaSessionPositionState();
    }
    async loadCurrent(options) {
        const item = this.getCurrentItem();
        if (!item) {
            return false;
        }
        const audio = this.ensureAudio();
        const loadGeneration = ++this.loadGeneration;
        this.stopMetadataPolling();
        this.loadedItemId = null;
        await this.withSuppressedElementPlaybackEvents(async () => {
            audio.pause();
            audio.currentTime = 0;
            audio.src = item.src;
        });
        this.syncAudioSettings();
        this.updateMediaSessionMetadata(item);
        this.updateMediaSessionHandlers();
        this.updateMediaSessionPlaybackState();
        this.updateMediaSessionPositionState();
        await new Promise((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                if (loadGeneration !== this.loadGeneration) {
                    resolve();
                    return;
                }
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
        if (loadGeneration !== this.loadGeneration) {
            return false;
        }
        if (typeof options.positionSeconds === 'number' && options.positionSeconds > 0) {
            const duration = this.getCurrentDuration();
            const clamped = typeof duration === 'number'
                ? Math.max(0, Math.min(options.positionSeconds, duration))
                : Math.max(0, options.positionSeconds);
            audio.currentTime = clamped;
        }
        this.loadedItemId = item.id;
        if (options.autoplay) {
            await this.withSuppressedElementPlaybackEvents(async () => {
                await audio.play();
            });
            if (loadGeneration !== this.loadGeneration) {
                return false;
            }
            this.status = 'playing';
            this.startMetadataPollingIfNeeded();
        }
        else {
            this.status = options.inactiveStatus;
            this.stopMetadataPolling();
        }
        await this.emitStateChange();
        if (options.emitTrackChange !== false) {
            await this.emitTrackChange();
        }
        return true;
    }
    async seekWithinLoadedCurrent(positionSeconds) {
        if (!this.audio || !this.isCurrentItemLoaded()) {
            return false;
        }
        const duration = this.getCurrentDuration();
        const target = typeof duration === 'number'
            ? Math.max(0, Math.min(positionSeconds, duration))
            : Math.max(0, positionSeconds);
        this.audio.currentTime = target;
        this.updateMediaSessionPositionState();
        return true;
    }
    startMetadataPollingIfNeeded() {
        var _a;
        this.stopMetadataPolling();
        if (this.status !== 'playing') {
            return;
        }
        const item = this.getCurrentItem();
        if (!(item === null || item === void 0 ? void 0 : item.metadataUpdateUrl)) {
            return;
        }
        const intervalSeconds = Math.max(5, (_a = item.metadataUpdateInterval) !== null && _a !== void 0 ? _a : 15);
        const pollGeneration = ++this.metadataPollGeneration;
        this.metadataPollTimer = setInterval(() => {
            if (pollGeneration !== this.metadataPollGeneration || this.metadataPollInFlight) {
                return;
            }
            const inFlightPromise = this.fetchAndApplyMetadata(item.id, item.metadataUpdateUrl, pollGeneration).finally(() => {
                if (this.metadataPollInFlight === inFlightPromise) {
                    this.metadataPollInFlight = null;
                }
            });
            this.metadataPollInFlight = inFlightPromise;
        }, intervalSeconds * 1000);
    }
    stopMetadataPolling() {
        if (this.metadataPollTimer) {
            clearInterval(this.metadataPollTimer);
            this.metadataPollTimer = null;
        }
        this.metadataPollGeneration += 1;
    }
    replaceItemEverywhere(itemId, updated) {
        this.baseQueue = this.baseQueue.map(item => (item.id === itemId ? updated : item));
        this.queue = this.queue.map(item => (item.id === itemId ? updated : item));
        if (this.shuffleQueue) {
            this.shuffleQueue = this.shuffleQueue.map(item => (item.id === itemId ? updated : item));
        }
    }
    async fetchAndApplyMetadata(itemId, url, pollGeneration) {
        var _a, _b, _c, _d;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return;
            }
            const payload = (await response.json());
            if (typeof pollGeneration === 'number' &&
                pollGeneration !== this.metadataPollGeneration) {
                return;
            }
            const title = typeof payload.title === 'string' ? payload.title : undefined;
            const artist = typeof payload.artist === 'string' ? payload.artist : undefined;
            const album = typeof payload.album === 'string' ? payload.album : undefined;
            const artwork = typeof payload.artwork === 'string' ? payload.artwork : undefined;
            if (!title && !artist && !album && !artwork) {
                return;
            }
            const currentIndex = this.queue.findIndex(item => item.id === itemId);
            if (currentIndex === -1) {
                return;
            }
            const current = this.queue[currentIndex];
            const changed = {};
            const updated = Object.assign({}, current);
            if (title && title !== current.title) {
                updated.title = title;
                changed.title = title;
            }
            if (artist && artist !== current.artist) {
                updated.artist = artist;
                changed.artist = artist;
            }
            if (album && album !== current.album) {
                updated.album = album;
                changed.album = album;
            }
            if (artwork && artwork !== current.artwork) {
                updated.artwork = artwork;
                changed.artwork = artwork;
            }
            if (Object.keys(changed).length === 0) {
                return;
            }
            const fingerprint = `${updated.title}|${(_a = updated.artist) !== null && _a !== void 0 ? _a : ''}|${(_b = updated.album) !== null && _b !== void 0 ? _b : ''}|${(_c = updated.artwork) !== null && _c !== void 0 ? _c : ''}`;
            if (this.metadataFingerprintByItemId.get(itemId) === fingerprint) {
                return;
            }
            this.metadataFingerprintByItemId.set(itemId, fingerprint);
            this.replaceItemEverywhere(itemId, updated);
            if (((_d = this.getCurrentItem()) === null || _d === void 0 ? void 0 : _d.id) === itemId) {
                this.updateMediaSessionMetadata(updated);
            }
            this.bumpStateRevision();
            await this.notifyListeners('metadataChange', {
                stateRevision: this.stateRevision,
                itemId,
                metadata: changed,
            });
            await this.emitQueueChange();
        }
        catch (_e) {
            // Metadata polling is best-effort only
        }
    }
    async handleEnded() {
        var _a, _b;
        const item = this.getCurrentItem();
        const now = Date.now();
        if (item) {
            const existing = this.progress.get(item.id);
            const durationSeconds = (_b = (_a = this.getCurrentDuration()) !== null && _a !== void 0 ? _a : existing === null || existing === void 0 ? void 0 : existing.durationSeconds) !== null && _b !== void 0 ? _b : 0;
            this.progress.set(item.id, {
                itemId: item.id,
                positionSeconds: durationSeconds,
                durationSeconds,
                completed: true,
                updatedAtEpochMs: now,
            });
        }
        if (this.repeatMode === 'one') {
            await this.seek({ positionSeconds: 0 });
            await this.play();
            return;
        }
        const lastIndex = this.queue.length - 1;
        if (this.currentIndex < lastIndex) {
            await this.skipToNext();
            return;
        }
        if (this.repeatMode === 'all' && this.queue.length > 0) {
            this.currentIndex = 0;
            await this.loadCurrent({
                autoplay: true,
                positionSeconds: 0,
                inactiveStatus: 'stopped',
            });
            return;
        }
        this.stopMetadataPolling();
        this.status = 'stopped';
        await this.emitStateChange();
    }
    buildState() {
        var _a;
        return {
            stateRevision: this.stateRevision,
            queueRevision: this.queueRevision,
            status: this.status,
            currentIndex: this.currentIndex,
            currentItemId: (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id,
            position: this.getCurrentPosition(),
            duration: this.getCurrentDuration(),
            rate: this.rate,
            volume: this.volume,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle,
        };
    }
    // Queue
    async setQueue(params) {
        var _a;
        const { items, startIndex = 0, startPositionSeconds = 0, autoplay = false } = params;
        const desiredItemId = (_a = items[Math.max(0, Math.min(startIndex, items.length - 1))]) === null || _a === void 0 ? void 0 : _a.id;
        this.baseQueue = [...items];
        this.updateEffectiveQueue(desiredItemId);
        if (this.queue.length === 0) {
            await this.resetQueueState();
            return;
        }
        this.currentIndex = this.resolveQueueIndex(desiredItemId, startIndex);
        this.bumpQueueRevision();
        const loaded = await this.loadCurrent({
            autoplay,
            positionSeconds: startPositionSeconds,
            inactiveStatus: 'stopped',
        });
        if (loaded) {
            await this.emitQueueChange();
        }
    }
    async syncQueue(params) {
        var _a, _b, _c, _d;
        const mode = (_a = params.mode) !== null && _a !== void 0 ? _a : 'replace';
        const hasExplicitStart = typeof params.startIndex === 'number' ||
            typeof params.startPositionSeconds === 'number';
        if (typeof params.expectedQueueRevision === 'number' &&
            params.expectedQueueRevision !== this.queueRevision &&
            !params.force) {
            throw new Error(`Queue revision mismatch: expected ${params.expectedQueueRevision}, got ${this.queueRevision}`);
        }
        if (mode === 'replace' || hasExplicitStart) {
            await this.setQueue({
                items: params.items,
                startIndex: params.currentItemId
                    ? params.items.findIndex(item => item.id === params.currentItemId)
                    : params.startIndex,
                startPositionSeconds: params.startPositionSeconds,
                autoplay: params.autoplay,
            });
            return { queueRevision: this.queueRevision };
        }
        if (mode !== 'patch') {
            throw new Error(`Unsupported syncQueue mode: ${String(mode)}`);
        }
        const previousItemId = (_b = params.currentItemId) !== null && _b !== void 0 ? _b : (_c = this.getCurrentItem()) === null || _c === void 0 ? void 0 : _c.id;
        const previousStatus = this.status;
        const previousPosition = this.getCurrentPosition();
        const shouldAutoplay = (_d = params.autoplay) !== null && _d !== void 0 ? _d : previousStatus === 'playing';
        const inactiveStatus = this.getInactiveStatusAfterLoad(previousStatus);
        this.baseQueue = [...params.items];
        this.updateEffectiveQueue(previousItemId);
        if (this.queue.length === 0) {
            await this.resetQueueState();
            return { queueRevision: this.queueRevision };
        }
        const preservedIndex = previousItemId
            ? this.queue.findIndex(item => item.id === previousItemId)
            : -1;
        this.currentIndex =
            preservedIndex !== -1
                ? preservedIndex
                : this.resolveQueueIndex(undefined, params.startIndex);
        this.bumpQueueRevision();
        if (preservedIndex !== -1 && this.loadedItemId === previousItemId && this.audio) {
            if (typeof params.startPositionSeconds === 'number') {
                await this.seekWithinLoadedCurrent(params.startPositionSeconds);
            }
            this.refreshMediaSessionState();
            if (params.autoplay === true && this.status !== 'playing') {
                await this.play();
                await this.emitQueueChange();
                return { queueRevision: this.queueRevision };
            }
            if (params.autoplay === false && this.status === 'playing') {
                await this.pause();
                await this.emitQueueChange();
                return { queueRevision: this.queueRevision };
            }
            if (this.status === 'playing') {
                this.startMetadataPollingIfNeeded();
            }
            else {
                this.stopMetadataPolling();
            }
            await this.emitQueueChange();
            await this.emitStateChange(false);
            return { queueRevision: this.queueRevision };
        }
        const loaded = await this.loadCurrent({
            autoplay: shouldAutoplay,
            positionSeconds: preservedIndex !== -1 ? previousPosition : 0,
            inactiveStatus,
        });
        if (loaded) {
            await this.emitQueueChange();
        }
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
        var _a;
        const previousItemId = (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id;
        const hadQueue = this.queue.length > 0;
        const insertion = typeof params.atIndex === 'number'
            ? Math.max(0, Math.min(params.atIndex, this.baseQueue.length))
            : this.baseQueue.length;
        this.baseQueue.splice(insertion, 0, ...params.items);
        this.updateEffectiveQueue(previousItemId, true);
        if (this.queue.length === 0) {
            await this.resetQueueState();
            return;
        }
        this.currentIndex =
            previousItemId !== undefined
                ? this.resolveQueueIndex(previousItemId)
                : this.resolveQueueIndex(undefined, insertion);
        this.bumpQueueRevision();
        if (!hadQueue) {
            const loaded = await this.loadCurrent({
                autoplay: false,
                positionSeconds: 0,
                inactiveStatus: 'stopped',
            });
            if (loaded) {
                await this.emitQueueChange();
            }
            return;
        }
        await this.emitQueueChange();
        await this.emitStateChange(false);
    }
    async removeQueueItem(params) {
        var _a;
        const previousItemId = (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id;
        const previousPosition = this.getCurrentPosition();
        const previousStatus = this.status;
        const previousIndex = this.currentIndex;
        this.baseQueue = this.baseQueue.filter(item => item.id !== params.itemId);
        this.updateEffectiveQueue(previousItemId, true);
        if (this.queue.length === 0) {
            await this.resetQueueState();
            return;
        }
        const preservedIndex = previousItemId
            ? this.queue.findIndex(item => item.id === previousItemId)
            : -1;
        this.currentIndex =
            preservedIndex !== -1
                ? preservedIndex
                : Math.max(0, Math.min(previousIndex, this.queue.length - 1));
        this.bumpQueueRevision();
        if (preservedIndex !== -1 && this.loadedItemId === previousItemId) {
            await this.emitQueueChange();
            await this.emitStateChange(false);
            return;
        }
        const loaded = await this.loadCurrent({
            autoplay: previousStatus === 'playing',
            positionSeconds: previousPosition,
            inactiveStatus: this.getInactiveStatusAfterLoad(previousStatus),
        });
        if (loaded) {
            await this.emitQueueChange();
        }
    }
    async moveQueueItem(params) {
        var _a;
        const { fromIndex, toIndex } = params;
        const queueLength = this.baseQueue.length;
        if (fromIndex < 0 ||
            fromIndex >= queueLength ||
            toIndex < 0 ||
            toIndex > queueLength) {
            return;
        }
        const previousItemId = (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id;
        const [item] = this.baseQueue.splice(fromIndex, 1);
        const insertionIndex = Math.min(toIndex, this.baseQueue.length);
        this.baseQueue.splice(insertionIndex, 0, item);
        this.updateEffectiveQueue(previousItemId, true);
        if (this.queue.length === 0) {
            await this.resetQueueState();
            return;
        }
        this.currentIndex =
            previousItemId !== undefined
                ? this.resolveQueueIndex(previousItemId)
                : this.resolveQueueIndex(undefined, 0);
        this.bumpQueueRevision();
        await this.emitQueueChange();
        await this.emitStateChange(false);
    }
    async clearQueue() {
        await this.resetQueueState();
    }
    // Playback
    async play() {
        const currentItem = this.getCurrentItem();
        if (!currentItem) {
            return;
        }
        if (!this.isCurrentItemLoaded()) {
            await this.loadCurrent({
                autoplay: true,
                positionSeconds: 0,
                inactiveStatus: 'stopped',
            });
            return;
        }
        const audio = this.ensureAudio();
        try {
            await this.withSuppressedElementPlaybackEvents(async () => {
                await audio.play();
            });
        }
        catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        this.status = 'playing';
        this.startMetadataPollingIfNeeded();
        await this.emitStateChange();
    }
    async pause() {
        if (!this.audio || !this.getCurrentItem() || this.status === 'stopped') {
            return;
        }
        await this.withSuppressedElementPlaybackEvents(() => {
            var _a;
            (_a = this.audio) === null || _a === void 0 ? void 0 : _a.pause();
        });
        this.status = 'paused';
        this.stopMetadataPolling();
        await this.emitStateChange();
    }
    async stop() {
        if (!this.audio || !this.getCurrentItem()) {
            return;
        }
        await this.withSuppressedElementPlaybackEvents(() => {
            if (!this.audio) {
                return;
            }
            this.audio.pause();
            this.audio.currentTime = 0;
        });
        this.status = 'stopped';
        this.stopMetadataPolling();
        await this.emitStateChange();
    }
    async seek(params) {
        if (!this.audio || !this.getCurrentItem()) {
            return;
        }
        const duration = this.getCurrentDuration();
        const target = typeof duration === 'number'
            ? Math.max(0, Math.min(params.positionSeconds, duration))
            : Math.max(0, params.positionSeconds);
        try {
            this.audio.currentTime = target;
        }
        catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        this.emitPassiveStateSnapshot();
    }
    async skipToPreviousInternal() {
        const position = this.getCurrentPosition();
        const threshold = this.playbackOptions.previousThresholdSeconds;
        if (position > threshold) {
            await this.seek({ positionSeconds: 0 });
            return;
        }
        if (this.currentIndex <= 0) {
            await this.seek({ positionSeconds: 0 });
            return;
        }
        const previousStatus = this.status;
        this.currentIndex -= 1;
        await this.loadCurrent({
            autoplay: previousStatus === 'playing',
            positionSeconds: 0,
            inactiveStatus: this.getInactiveStatusAfterLoad(previousStatus),
        });
    }
    async skipToNext() {
        if (this.currentIndex >= this.queue.length - 1) {
            return;
        }
        const previousStatus = this.status;
        this.currentIndex += 1;
        await this.loadCurrent({
            autoplay: previousStatus === 'playing',
            positionSeconds: 0,
            inactiveStatus: this.getInactiveStatusAfterLoad(previousStatus),
        });
    }
    // Methods required by the interface
    async skipToPrevious() {
        await this.skipToPreviousInternal();
    }
    async skipToIndex(params) {
        var _a;
        if (this.queue.length === 0) {
            return;
        }
        const previousStatus = this.status;
        this.currentIndex = Math.max(0, Math.min(params.index, this.queue.length - 1));
        await this.loadCurrent({
            autoplay: previousStatus === 'playing',
            positionSeconds: (_a = params.positionSeconds) !== null && _a !== void 0 ? _a : 0,
            inactiveStatus: this.getInactiveStatusAfterLoad(previousStatus),
        });
    }
    async setRate(params) {
        const clamped = Math.max(0.25, Math.min(4, params.rate));
        this.rate = clamped;
        if (this.audio) {
            this.audio.playbackRate = clamped;
        }
        await this.emitStateChange();
    }
    async setVolume(params) {
        const vol = Math.max(0, Math.min(100, params.volume));
        this.volume = vol;
        if (this.audio) {
            this.audio.volume = vol / 100;
        }
        await this.emitStateChange();
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
    async setPlaybackOptions(params) {
        this.playbackOptions = Object.assign(Object.assign({}, this.playbackOptions), params);
        this.updateMediaSessionHandlers();
        this.refreshMediaSessionState();
        await this.emitStateChange();
    }
    getPlaybackOptions() {
        return Promise.resolve(this.playbackOptions);
    }
    // Playback modes
    async setRepeatMode(params) {
        this.repeatMode = params.repeatMode;
        await this.emitStateChange();
    }
    async setShuffle(params) {
        var _a;
        const previousItemId = (_a = this.getCurrentItem()) === null || _a === void 0 ? void 0 : _a.id;
        const previousStatus = this.status;
        const previousPosition = this.getCurrentPosition();
        this.shuffle = params.shuffle;
        this.updateEffectiveQueue(previousItemId);
        if (this.queue.length === 0) {
            this.bumpQueueRevision();
            await this.emitQueueChange();
            await this.emitStateChange(false);
            return;
        }
        this.currentIndex = this.resolveQueueIndex(previousItemId, this.currentIndex);
        this.bumpQueueRevision();
        if (previousItemId && this.loadedItemId === previousItemId) {
            await this.emitQueueChange();
            await this.emitStateChange(false);
            return;
        }
        const loaded = await this.loadCurrent({
            autoplay: previousStatus === 'playing',
            positionSeconds: previousPosition,
            inactiveStatus: this.getInactiveStatusAfterLoad(previousStatus),
        });
        if (loaded) {
            await this.emitQueueChange();
        }
    }
}

var web = /*#__PURE__*/Object.freeze({
    __proto__: null,
    AudioPlayerWeb: AudioPlayerWeb
});

exports.AudioPlayer = AudioPlayer;
//# sourceMappingURL=plugin.cjs.js.map

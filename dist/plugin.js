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
    const POSITION_STATE_THROTTLE_MS = 400;
    const ITEM_PROGRESS_STORAGE_PREFIX = 'cap_native_audio:itemProgress:v1:';
    class AudioPlayerWeb extends core.WebPlugin {
        constructor() {
            super();
            this.items = [];
            this.baseItems = [];
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
            this.playToken = 0;
            // Optional audio graph for smooth volume ramping (HTMLAudioElement remains source of truth).
            this.audioCtx = null;
            this.audioCtxNode = null;
            this.gainNode = null;
            this.lastPositionStateUpdateMs = 0;
            this.metadataTimer = null;
            this.lastMetadataFingerprint = null;
            this.metadataItemId = null;
            this.ensureAudio();
        }
        bumpPlayToken() {
            this.playToken += 1;
            return this.playToken;
        }
        ensureAudio() {
            if (this.audio)
                return this.audio;
            const audio = new Audio();
            audio.preload = 'auto';
            audio.addEventListener('ended', () => this.onAudioEnded());
            audio.addEventListener('play', () => this.setStatus('playing'));
            audio.addEventListener('pause', () => {
                // `stop()` pauses first, then synchronously sets status to `stopped`.
                // The DOM `pause` event can fire async and must not override a stopped state.
                if (this.status === 'stopped')
                    return;
                if (audio.currentTime === 0 && !audio.src)
                    return;
                this.setStatus('paused');
            });
            audio.addEventListener('error', () => this.setStatus('stopped'));
            audio.addEventListener('timeupdate', () => this.updatePositionState());
            audio.addEventListener('loadedmetadata', () => this.updatePositionState(true));
            audio.addEventListener('durationchange', () => this.updatePositionState(true));
            this.audio = audio;
            return audio;
        }
        ensureAudioGraph() {
            var _a, _b;
            // Lazily create an AudioContext graph for smooth volume ramping.
            // Some browsers require a user gesture before creating/resuming AudioContext;
            // fall back to HTMLAudioElement.volume if we can't create it.
            if (typeof window === 'undefined')
                return;
            const audio = this.ensureAudio();
            if (this.audioCtx && this.gainNode && this.audioCtxNode)
                return;
            const Ctx = (_a = window.AudioContext) !== null && _a !== void 0 ? _a : window.webkitAudioContext;
            if (!Ctx)
                return;
            try {
                const ctx = (_b = this.audioCtx) !== null && _b !== void 0 ? _b : new Ctx();
                this.audioCtx = ctx;
                if (!this.audioCtxNode) {
                    this.audioCtxNode = ctx.createMediaElementSource(audio);
                }
                if (!this.gainNode) {
                    this.gainNode = ctx.createGain();
                    this.audioCtxNode.connect(this.gainNode);
                    this.gainNode.connect(ctx.destination);
                }
                // Prefer gain control as the source of truth when available.
                audio.volume = 1;
                this.applyGainVolume(this.volumePercent);
                if (ctx.state === 'suspended') {
                    void ctx.resume().catch(() => {
                        // ignore
                    });
                }
            }
            catch (_c) {
                // ignore
            }
        }
        applyGainVolume(volume0To100) {
            const ctx = this.audioCtx;
            const gain = this.gainNode;
            if (!ctx || !gain)
                return;
            const v = Math.max(0, Math.min(100, volume0To100)) / 100;
            const now = ctx.currentTime;
            try {
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(gain.gain.value, now);
                gain.gain.linearRampToValueAtTime(v, now + 0.01);
            }
            catch (_a) {
                // ignore
            }
        }
        setStatus(status) {
            if (this.status === status)
                return;
            this.status = status;
            this.emitStateChange();
            if (status === 'playing') {
                this.startStatePolling();
                this.startMetadataPollingIfNeeded();
            }
            else {
                this.stopStatePolling();
                this.stopMetadataPolling();
            }
            this.updateMediaSessionPlaybackState();
            this.updatePositionState(true);
        }
        updateMediaSessionPlaybackState() {
            if (typeof navigator === 'undefined' || !navigator.mediaSession)
                return;
            try {
                // 'none' is supported on many browsers; if not, this is a no-op.
                const ps = this.status === 'playing' ? 'playing' : this.status === 'paused' ? 'paused' : 'none';
                navigator.mediaSession.playbackState = ps;
            }
            catch (_a) {
                // ignore
            }
        }
        updatePositionState(force = false) {
            var _a;
            if (typeof navigator === 'undefined' || !navigator.mediaSession)
                return;
            const audio = this.audio;
            if (!audio)
                return;
            const nowMs = Date.now();
            if (!force && nowMs - this.lastPositionStateUpdateMs < POSITION_STATE_THROTTLE_MS)
                return;
            this.lastPositionStateUpdateMs = nowMs;
            const duration = this.getDuration();
            if (!(duration > 0) || !isFinite(duration))
                return;
            try {
                // setPositionState is not supported everywhere
                const ms = navigator.mediaSession;
                if (typeof ms.setPositionState === 'function') {
                    ms.setPositionState({
                        duration,
                        playbackRate: this.rate,
                        position: Math.max(0, (_a = audio.currentTime) !== null && _a !== void 0 ? _a : 0),
                    });
                }
            }
            catch (_b) {
                // ignore
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
            this.bumpPlayToken();
            this.currentIndex = index;
            const item = this.items[index];
            const audio = this.ensureAudio();
            audio.pause();
            audio.src = item.src;
            audio.load();
            this.applyPlaybackRate(audio);
            this.updateMediaSessionMetadata(item);
            this.setupMediaSessionHandlers();
            this.updatePositionState(true);
            this.emitStateChange();
        }
        applyPlaybackRate(audio) {
            // Per spec, calling `load()` resets `playbackRate` to `defaultPlaybackRate`.
            // Keep both in sync so rate survives track changes.
            audio.defaultPlaybackRate = this.rate;
            audio.playbackRate = this.rate;
        }
        shuffleItems(items) {
            const arr = [...items];
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        }
        buildShuffleQueueFromBase(desiredCurrentItemId) {
            if (this.baseItems.length === 0)
                return [];
            if (!desiredCurrentItemId) {
                return this.shuffleItems(this.baseItems);
            }
            const idx = this.baseItems.findIndex((x) => x.id === desiredCurrentItemId);
            if (idx === -1) {
                return this.shuffleItems(this.baseItems);
            }
            const current = this.baseItems[idx];
            const rest = this.baseItems.filter((x) => x.id !== desiredCurrentItemId);
            return [current, ...this.shuffleItems(rest)];
        }
        rebuildEffectiveQueue(desiredCurrentItemId) {
            this.items = this.shuffle
                ? this.buildShuffleQueueFromBase(desiredCurrentItemId)
                : [...this.baseItems];
            if (this.items.length === 0) {
                this.currentIndex = 0;
                return;
            }
            if (desiredCurrentItemId) {
                const idx = this.items.findIndex((x) => x.id === desiredCurrentItemId);
                if (idx !== -1) {
                    this.currentIndex = idx;
                    return;
                }
            }
            this.currentIndex = Math.max(0, Math.min(this.currentIndex, this.items.length - 1));
        }
        resolveSrcForCompare(src) {
            var _a;
            if (!src)
                return '';
            try {
                if (typeof document !== 'undefined' && document.baseURI) {
                    return new URL(src, document.baseURI).href;
                }
                if (typeof window !== 'undefined' && ((_a = window.location) === null || _a === void 0 ? void 0 : _a.href)) {
                    return new URL(src, window.location.href).href;
                }
            }
            catch (_b) {
                // ignore
            }
            return src;
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
                else {
                    navigator.mediaSession.setActionHandler('stop', null);
                }
                if (opts.enableSeekTo) {
                    navigator.mediaSession.setActionHandler('seekto', (details) => {
                        if (this.audio && typeof (details === null || details === void 0 ? void 0 : details.seekTime) === 'number') {
                            this.audio.currentTime = details.seekTime;
                            this.emitStateChange();
                            this.updatePositionState(true);
                        }
                    });
                }
                else {
                    navigator.mediaSession.setActionHandler('seekto', null);
                }
                if (opts.enableSkipForwardBackward) {
                    const fwd = (_a = opts.skipForwardSeconds) !== null && _a !== void 0 ? _a : 10;
                    const bwd = (_b = opts.skipBackwardSeconds) !== null && _b !== void 0 ? _b : 10;
                    navigator.mediaSession.setActionHandler('seekforward', (details) => {
                        if (this.audio) {
                            const offset = typeof (details === null || details === void 0 ? void 0 : details.seekOffset) === 'number' ? details.seekOffset : fwd;
                            this.audio.currentTime = Math.min(this.audio.duration || Number.MAX_SAFE_INTEGER, this.audio.currentTime + offset);
                            this.emitStateChange();
                            this.updatePositionState(true);
                        }
                    });
                    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                        if (this.audio) {
                            const offset = typeof (details === null || details === void 0 ? void 0 : details.seekOffset) === 'number' ? details.seekOffset : bwd;
                            this.audio.currentTime = Math.max(0, this.audio.currentTime - offset);
                            this.emitStateChange();
                            this.updatePositionState(true);
                        }
                    });
                }
                else {
                    navigator.mediaSession.setActionHandler('seekforward', null);
                    navigator.mediaSession.setActionHandler('seekbackward', null);
                }
                if (opts.enableNextPrev) {
                    navigator.mediaSession.setActionHandler('nexttrack', () => {
                        void this.skipToNext();
                    });
                    navigator.mediaSession.setActionHandler('previoustrack', () => {
                        void this.skipToPrevious();
                    });
                }
                else {
                    navigator.mediaSession.setActionHandler('nexttrack', null);
                    navigator.mediaSession.setActionHandler('previoustrack', null);
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
        emitMetadataChange(itemId, metadata) {
            const event = {
                stateRevision: this.stateRevision,
                itemId,
                metadata,
            };
            this.metadataChangeListeners.forEach((fn) => {
                try {
                    fn(event);
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
            var _a, _b, _c;
            const token = this.bumpPlayToken();
            this.baseItems = ((_a = params.items) === null || _a === void 0 ? void 0 : _a.length) ? [...params.items] : [];
            this.queueRevision++;
            const startIndex = Math.max(0, Math.min((_b = params.startIndex) !== null && _b !== void 0 ? _b : 0, Math.max(0, this.baseItems.length - 1)));
            const desiredCurrentItemId = (_c = this.baseItems[startIndex]) === null || _c === void 0 ? void 0 : _c.id;
            this.rebuildEffectiveQueue(desiredCurrentItemId);
            const audio = this.ensureAudio();
            audio.pause();
            if (this.items.length) {
                const item = this.items[this.currentIndex];
                audio.src = item.src;
                audio.load();
                this.applyPlaybackRate(audio);
                if (params.startPositionSeconds != null && params.startPositionSeconds > 0) {
                    audio.currentTime = params.startPositionSeconds;
                }
                this.updateMediaSessionMetadata(item);
                this.setupMediaSessionHandlers();
                if (params.autoplay) {
                    void this.playWithToken(token);
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
            var _a, _b, _c;
            const force = params.force === true;
            if (params.expectedQueueRevision != null &&
                params.expectedQueueRevision !== this.queueRevision &&
                !force) {
                return { queueRevision: this.queueRevision };
            }
            if (params.mode === 'replace') {
                await this.setQueue(params);
                return { queueRevision: this.queueRevision };
            }
            if (params.mode === 'patch') {
                // If shuffle is enabled, patch semantics become ambiguous; treat as replace.
                if (this.shuffle) {
                    await this.setQueue(params);
                    return { queueRevision: this.queueRevision };
                }
                // If caller specified explicit start index/position, treat as replace.
                if (params.startIndex != null || params.startPositionSeconds != null) {
                    await this.setQueue(params);
                    return { queueRevision: this.queueRevision };
                }
                const desiredCurrentItemId = (_a = params.currentItemId) !== null && _a !== void 0 ? _a : (_b = this.items[this.currentIndex]) === null || _b === void 0 ? void 0 : _b.id;
                const audio = this.audio;
                const newItems = ((_c = params.items) === null || _c === void 0 ? void 0 : _c.length) ? [...params.items] : [];
                if (!desiredCurrentItemId || !audio || newItems.length === 0) {
                    await this.setQueue(params);
                    return { queueRevision: this.queueRevision };
                }
                const currentIndexInNew = newItems.findIndex((x) => x.id === desiredCurrentItemId);
                if (currentIndexInNew === -1) {
                    await this.setQueue(params);
                    return { queueRevision: this.queueRevision };
                }
                const desiredItem = newItems[currentIndexInNew];
                const currentSrc = audio.currentSrc || audio.src || '';
                const currentResolved = this.resolveSrcForCompare(currentSrc);
                const desiredResolved = this.resolveSrcForCompare(desiredItem.src);
                // Only preserve if the currently loaded media matches the desired queue item src.
                if (!currentResolved || !desiredResolved || currentResolved !== desiredResolved) {
                    await this.setQueue(params);
                    return { queueRevision: this.queueRevision };
                }
                // Patch in-place: update logical queue/index while keeping current media playing.
                this.baseItems = newItems;
                this.rebuildEffectiveQueue(desiredCurrentItemId);
                this.queueRevision++;
                // Refresh Media Session metadata (may have changed) and keep handlers in sync.
                this.updateMediaSessionMetadata(desiredItem);
                this.setupMediaSessionHandlers();
                this.updatePositionState(true);
                this.emitQueueChange();
                this.emitTrackChange();
                this.emitStateChange();
                if (params.autoplay && this.status !== 'playing') {
                    try {
                        await this.play();
                    }
                    catch (_d) {
                        // ignore autoplay failures
                    }
                }
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
            var _a, _b, _c, _d;
            if (this.baseItems.length === 0 && this.items.length > 0) {
                this.baseItems = [...this.items];
            }
            const beforeLength = this.baseItems.length;
            const desiredCurrentItemId = (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id;
            const insertItems = (_b = params.items) !== null && _b !== void 0 ? _b : [];
            const atRaw = (_c = params.atIndex) !== null && _c !== void 0 ? _c : this.baseItems.length;
            const at = Math.max(0, Math.min(atRaw, this.baseItems.length));
            this.baseItems.splice(at, 0, ...insertItems);
            this.rebuildEffectiveQueue(desiredCurrentItemId);
            // If queue was empty and now has items, initialize the current item (without autoplay).
            if (beforeLength === 0 && this.items.length > 0) {
                const desiredId = (_d = this.items[0]) === null || _d === void 0 ? void 0 : _d.id;
                this.rebuildEffectiveQueue(desiredId);
                this.loadItemByIndex(this.currentIndex);
                this.setStatus('stopped');
            }
            this.queueRevision++;
            this.emitQueueChange();
            this.emitStateChange();
        }
        async removeQueueItem(params) {
            var _a, _b, _c, _d, _e;
            if (this.baseItems.length === 0 && this.items.length > 0) {
                this.baseItems = [...this.items];
            }
            const statusBefore = this.status;
            const oldItems = [...this.items];
            const oldIndex = this.currentIndex;
            const beforeCurrentItemId = (_a = oldItems[oldIndex]) === null || _a === void 0 ? void 0 : _a.id;
            const removedWasCurrent = beforeCurrentItemId === params.itemId;
            const iBase = this.baseItems.findIndex((x) => x.id === params.itemId);
            if (iBase === -1)
                return;
            this.baseItems.splice(iBase, 1);
            this.queueRevision++;
            if (this.baseItems.length === 0) {
                this.items = [];
                if (this.audio) {
                    this.audio.pause();
                    this.audio.src = '';
                }
                this.currentIndex = 0;
                this.setStatus('stopped');
                this.emitQueueChange();
                this.emitStateChange();
                return;
            }
            if (!removedWasCurrent) {
                // Preserve the current item by id; do NOT reload audio.
                this.rebuildEffectiveQueue(beforeCurrentItemId);
            }
            else {
                // Current item removed: move to the next logical item (or previous if we were last).
                let candidateNextId;
                if (oldIndex < oldItems.length - 1) {
                    candidateNextId = (_b = oldItems[oldIndex + 1]) === null || _b === void 0 ? void 0 : _b.id;
                }
                else if (oldItems.length >= 2) {
                    candidateNextId = (_c = oldItems[oldItems.length - 2]) === null || _c === void 0 ? void 0 : _c.id;
                }
                this.rebuildEffectiveQueue(candidateNextId);
                this.loadItemByIndex(this.currentIndex);
                this.setStatus(statusBefore);
                if (statusBefore === 'playing') {
                    void ((_d = this.audio) === null || _d === void 0 ? void 0 : _d.play());
                }
            }
            const afterCurrentItemId = (_e = this.items[this.currentIndex]) === null || _e === void 0 ? void 0 : _e.id;
            if (beforeCurrentItemId && afterCurrentItemId && beforeCurrentItemId !== afterCurrentItemId) {
                this.emitTrackChange();
            }
            this.emitQueueChange();
            this.emitStateChange();
        }
        async moveQueueItem(params) {
            var _a;
            if (this.baseItems.length === 0 && this.items.length > 0) {
                this.baseItems = [...this.items];
            }
            const { fromIndex, toIndex } = params;
            const desiredCurrentItemId = (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id;
            if (fromIndex < 0 ||
                fromIndex >= this.baseItems.length ||
                toIndex < 0 ||
                toIndex >= this.baseItems.length)
                return;
            const [item] = this.baseItems.splice(fromIndex, 1);
            this.baseItems.splice(toIndex, 0, item);
            this.queueRevision++;
            this.rebuildEffectiveQueue(desiredCurrentItemId);
            this.emitQueueChange();
            this.emitStateChange();
        }
        async clearQueue() {
            this.bumpPlayToken();
            this.items = [];
            this.baseItems = [];
            this.currentIndex = 0;
            this.queueRevision++;
            const audio = this.audio;
            if (audio) {
                audio.pause();
                audio.src = '';
            }
            this.setStatus('stopped');
            this.stopMetadataPolling();
            this.emitQueueChange();
            this.emitStateChange();
        }
        // --- Playback ---
        async playWithToken(token) {
            if (token !== this.playToken)
                return;
            try {
                await this.play();
            }
            catch (_a) {
                // ignore autoplay failures
            }
        }
        async play() {
            const audio = this.ensureAudio();
            if (this.items.length && !audio.src) {
                const item = this.items[this.currentIndex];
                if (item) {
                    audio.src = item.src;
                    audio.load();
                    this.applyPlaybackRate(audio);
                    this.updateMediaSessionMetadata(item);
                    this.setupMediaSessionHandlers();
                }
            }
            const token = this.playToken;
            try {
                await audio.play();
                if (token !== this.playToken)
                    return;
                // ensure AudioContext gets a chance to resume after a user gesture
                if (this.audioCtx && this.audioCtx.state === 'suspended') {
                    void this.audioCtx.resume().catch(() => {
                        // ignore
                    });
                }
            }
            catch (err) {
                if (token !== this.playToken)
                    return;
                // If play fails (e.g. user gesture), keep status consistent.
                if (this.status === 'playing')
                    this.setStatus('paused');
                throw err instanceof Error ? err : new Error(String(err));
            }
        }
        async pause() {
            var _a;
            (_a = this.audio) === null || _a === void 0 ? void 0 : _a.pause();
            this.setStatus('paused');
        }
        async stop() {
            const wasStopped = this.status === 'stopped';
            const audio = this.audio;
            if (audio) {
                audio.pause();
                audio.currentTime = 0;
            }
            this.setStatus('stopped');
            if (wasStopped) {
                // `setStatus()` won't emit if status didn't change, but `stop()` still resets position.
                this.emitStateChange();
                this.updatePositionState(true);
            }
        }
        async seek(params) {
            const audio = this.audio;
            if (!audio)
                return;
            audio.currentTime = Math.max(0, params.positionSeconds);
            this.emitStateChange();
            this.updatePositionState(true);
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
            const prevIndex = atStart
                ? this.currentIndex > 0
                    ? this.currentIndex - 1
                    : this.repeatMode === 'all' && this.items.length > 0
                        ? this.items.length - 1
                        : this.currentIndex
                : this.currentIndex;
            if (prevIndex !== this.currentIndex) {
                this.loadItemByIndex(prevIndex);
                this.emitTrackChange();
                if (this.status === 'playing')
                    void ((_c = this.audio) === null || _c === void 0 ? void 0 : _c.play());
            }
            else if (audio) {
                audio.currentTime = 0;
                this.emitStateChange();
                this.updatePositionState(true);
            }
        }
        async skipToIndex(params) {
            var _a;
            const index = Math.max(0, Math.min(params.index, this.items.length - 1));
            if (index === this.currentIndex) {
                if (params.positionSeconds != null && this.audio) {
                    this.audio.currentTime = params.positionSeconds;
                    this.emitStateChange();
                    this.updatePositionState(true);
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
                this.applyPlaybackRate(this.audio);
            this.emitStateChange();
            this.updatePositionState(true);
        }
        async setVolume(params) {
            this.volumePercent = Math.max(0, Math.min(100, params.volume));
            this.ensureAudioGraph();
            if (this.gainNode && this.audioCtx) {
                this.applyGainVolume(this.volumePercent);
            }
            else if (this.audio) {
                this.audio.volume = this.volumePercent / 100;
            }
            this.emitStateChange();
        }
        // --- State ---
        async getState() {
            return this.buildPlayerState();
        }
        // --- Progress / bookmarks (localStorage + in-memory cache on web) ---
        async setItemProgress(params) {
            const progress = {
                itemId: params.itemId,
                positionSeconds: params.positionSeconds,
                durationSeconds: params.durationSeconds,
                completed: params.completed,
                updatedAtEpochMs: Date.now(),
            };
            this.progressMap.set(params.itemId, progress);
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(`${ITEM_PROGRESS_STORAGE_PREFIX}${params.itemId}`, JSON.stringify(progress));
                }
            }
            catch (_a) {
                // ignore
            }
        }
        async getItemProgress(params) {
            var _a;
            const stored = this.progressMap.get(params.itemId);
            if (stored)
                return stored;
            try {
                if (typeof localStorage !== 'undefined') {
                    const raw = localStorage.getItem(`${ITEM_PROGRESS_STORAGE_PREFIX}${params.itemId}`);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        if (parsed &&
                            typeof parsed.itemId === 'string' &&
                            typeof parsed.positionSeconds === 'number' &&
                            typeof parsed.updatedAtEpochMs === 'number') {
                            const progress = {
                                itemId: parsed.itemId,
                                positionSeconds: parsed.positionSeconds,
                                durationSeconds: typeof parsed.durationSeconds === 'number' ? parsed.durationSeconds : undefined,
                                completed: typeof parsed.completed === 'boolean' ? parsed.completed : undefined,
                                updatedAtEpochMs: parsed.updatedAtEpochMs,
                            };
                            this.progressMap.set(params.itemId, progress);
                            return progress;
                        }
                    }
                }
            }
            catch (_b) {
                // ignore
            }
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
            var _a;
            if (this.shuffle === params.shuffle)
                return;
            const desiredCurrentItemId = (_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id;
            // Ensure baseItems is populated (defensive for older state).
            if (this.baseItems.length === 0 && this.items.length > 0) {
                this.baseItems = [...this.items];
            }
            this.shuffle = params.shuffle;
            this.queueRevision++;
            this.rebuildEffectiveQueue(desiredCurrentItemId);
            const current = this.items[this.currentIndex];
            if (current) {
                this.updateMediaSessionMetadata(current);
                this.setupMediaSessionHandlers();
            }
            this.emitQueueChange();
            this.emitStateChange();
        }
        // --- Stream metadata polling (web) ---
        startMetadataPollingIfNeeded() {
            var _a;
            this.stopMetadataPolling();
            if (this.status !== 'playing')
                return;
            const item = this.items[this.currentIndex];
            if (!(item === null || item === void 0 ? void 0 : item.metadataUpdateUrl))
                return;
            const url = String(item.metadataUpdateUrl);
            if (!url.trim())
                return;
            const intervalSeconds = Math.max(5, (_a = item.metadataUpdateInterval) !== null && _a !== void 0 ? _a : 15);
            this.metadataItemId = item.id;
            this.lastMetadataFingerprint = null;
            this.metadataTimer = setInterval(() => {
                void this.fetchAndApplyStreamMetadata(url, item.id, this.playToken);
            }, intervalSeconds * 1000);
        }
        stopMetadataPolling() {
            if (this.metadataTimer) {
                clearInterval(this.metadataTimer);
                this.metadataTimer = null;
            }
            this.metadataItemId = null;
            this.lastMetadataFingerprint = null;
        }
        async fetchAndApplyStreamMetadata(url, itemId, token) {
            var _a, _b;
            if (token !== this.playToken)
                return;
            if (this.status !== 'playing')
                return;
            if (((_a = this.items[this.currentIndex]) === null || _a === void 0 ? void 0 : _a.id) !== itemId)
                return;
            let data;
            try {
                const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timeout = setTimeout(() => controller === null || controller === void 0 ? void 0 : controller.abort(), 5000);
                const res = await fetch(url, { signal: controller === null || controller === void 0 ? void 0 : controller.signal });
                clearTimeout(timeout);
                if (!res.ok)
                    return;
                data = await res.json();
            }
            catch (_c) {
                return;
            }
            if (token !== this.playToken)
                return;
            if (((_b = this.items[this.currentIndex]) === null || _b === void 0 ? void 0 : _b.id) !== itemId)
                return;
            const obj = data;
            const title = typeof (obj === null || obj === void 0 ? void 0 : obj.title) === 'string' ? obj.title : undefined;
            const artist = typeof (obj === null || obj === void 0 ? void 0 : obj.artist) === 'string' ? obj.artist : undefined;
            const album = typeof (obj === null || obj === void 0 ? void 0 : obj.album) === 'string' ? obj.album : undefined;
            const artwork = typeof (obj === null || obj === void 0 ? void 0 : obj.artwork) === 'string' ? obj.artwork : undefined;
            if (!title && !artist && !album && !artwork)
                return;
            const fingerprint = `${title !== null && title !== void 0 ? title : ''}|${artist !== null && artist !== void 0 ? artist : ''}|${album !== null && album !== void 0 ? album : ''}|${artwork !== null && artwork !== void 0 ? artwork : ''}`;
            if (fingerprint === this.lastMetadataFingerprint)
                return;
            this.lastMetadataFingerprint = fingerprint;
            const current = this.items[this.currentIndex];
            if (!current)
                return;
            const changed = {};
            if (title && title !== current.title)
                changed.title = title;
            if (artist && artist !== current.artist)
                changed.artist = artist;
            if (album && album !== current.album)
                changed.album = album;
            if (artwork && artwork !== current.artwork)
                changed.artwork = artwork;
            if (Object.keys(changed).length === 0)
                return;
            const updated = Object.assign(Object.assign({}, current), changed);
            this.items[this.currentIndex] = updated;
            const baseIndex = this.baseItems.findIndex((x) => x.id === itemId);
            if (baseIndex !== -1) {
                this.baseItems[baseIndex] = Object.assign(Object.assign({}, this.baseItems[baseIndex]), changed);
            }
            this.updateMediaSessionMetadata(updated);
            // Emit state change first to bump stateRevision, then emit metadataChange with that revision.
            this.emitStateChange();
            this.emitMetadataChange(itemId, changed);
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

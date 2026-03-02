import { WebPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import type {
    AddQueueItemsParams,
    GetItemProgressParams,
    GetQueueResult,
    ItemProgress,
    MetadataChangeEvent,
    PlaybackOptions,
    PlayerState,
    QueueChangeEvent,
    QueueItem,
    RemoveQueueItemParams,
    SeekParams,
    SetItemProgressParams,
    SetPlaybackOptionsParams,
    SetQueueParams,
    SetRateParams,
    SetRepeatModeParams,
    SetShuffleParams,
    SetVolumeParams,
    SkipToIndexParams,
    SyncQueueParams,
    SyncQueueResult,
    MoveQueueItemParams,
    PlaybackStatus,
    RepeatMode,
    TrackChangeEvent,
} from './definitions';

const DEFAULT_PLAYBACK_OPTIONS: PlaybackOptions = {
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

export class AudioPlayerWeb extends WebPlugin {
    private items: QueueItem[] = [];
    private baseItems: QueueItem[] = [];
    private currentIndex = 0;
    private queueRevision = 0;
    private stateRevision = 0;
    private status: PlaybackStatus = 'stopped';
    private rate = 1;
    private volumePercent = 100;
    private repeatMode: RepeatMode = 'off';
    private shuffle = false;
    private playbackOptions: PlaybackOptions = { ...DEFAULT_PLAYBACK_OPTIONS };
    private progressMap = new Map<string, ItemProgress>();

    private audio: HTMLAudioElement | null = null;
    private statePollTimer: ReturnType<typeof setInterval> | null = null;

    private stateChangeListeners: ((state: PlayerState) => void)[] = [];
    private trackChangeListeners: ((event: TrackChangeEvent) => void)[] = [];
    private queueChangeListeners: ((event: QueueChangeEvent) => void)[] = [];
    private metadataChangeListeners: ((event: MetadataChangeEvent) => void)[] = [];
    private audioBecomingNoisyListeners: (() => void)[] = [];

    private playToken = 0;

    // Optional audio graph for smooth volume ramping (HTMLAudioElement remains source of truth).
    private audioCtx: AudioContext | null = null;
    private audioCtxNode: MediaElementAudioSourceNode | null = null;
    private gainNode: GainNode | null = null;

    private lastPositionStateUpdateMs = 0;

    private metadataTimer: ReturnType<typeof setInterval> | null = null;
    private lastMetadataFingerprint: string | null = null;
    private metadataItemId: string | null = null;

    constructor() {
        super();
        this.ensureAudio();
    }

    private bumpPlayToken(): number {
        this.playToken += 1;
        return this.playToken;
    }

    private ensureAudio(): HTMLAudioElement {
        if (this.audio) return this.audio;
        const audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('ended', () => this.onAudioEnded());
        audio.addEventListener('play', () => this.setStatus('playing'));
        audio.addEventListener('pause', () => {
            // `stop()` pauses first, then synchronously sets status to `stopped`.
            // The DOM `pause` event can fire async and must not override a stopped state.
            if (this.status === 'stopped') return;
            if (audio.currentTime === 0 && !audio.src) return;
            this.setStatus('paused');
        });
        audio.addEventListener('error', () => this.setStatus('stopped'));
        audio.addEventListener('timeupdate', () => this.updatePositionState());
        audio.addEventListener('loadedmetadata', () => this.updatePositionState(true));
        audio.addEventListener('durationchange', () => this.updatePositionState(true));
        this.audio = audio;
        return audio;
    }

    private ensureAudioGraph(): void {
        // Lazily create an AudioContext graph for smooth volume ramping.
        // Some browsers require a user gesture before creating/resuming AudioContext;
        // fall back to HTMLAudioElement.volume if we can't create it.
        if (typeof window === 'undefined') return;
        const audio = this.ensureAudio();
        if (this.audioCtx && this.gainNode && this.audioCtxNode) return;

        const Ctx =
            (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;

        try {
            const ctx = this.audioCtx ?? new Ctx();
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
        } catch {
            // ignore
        }
    }

    private applyGainVolume(volume0To100: number): void {
        const ctx = this.audioCtx;
        const gain = this.gainNode;
        if (!ctx || !gain) return;
        const v = Math.max(0, Math.min(100, volume0To100)) / 100;
        const now = ctx.currentTime;
        try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(v, now + 0.01);
        } catch {
            // ignore
        }
    }

    private setStatus(status: PlaybackStatus): void {
        if (this.status === status) return;
        this.status = status;
        this.emitStateChange();
        if (status === 'playing') {
            this.startStatePolling();
            this.startMetadataPollingIfNeeded();
        } else {
            this.stopStatePolling();
            this.stopMetadataPolling();
        }
        this.updateMediaSessionPlaybackState();
        this.updatePositionState(true);
    }

    private updateMediaSessionPlaybackState(): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
        try {
            // 'none' is supported on many browsers; if not, this is a no-op.
            const ps = this.status === 'playing' ? 'playing' : this.status === 'paused' ? 'paused' : 'none';
            (navigator.mediaSession as unknown as { playbackState?: string }).playbackState = ps;
        } catch {
            // ignore
        }
    }

    private updatePositionState(force = false): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
        const audio = this.audio;
        if (!audio) return;

        const nowMs = Date.now();
        if (!force && nowMs - this.lastPositionStateUpdateMs < POSITION_STATE_THROTTLE_MS) return;
        this.lastPositionStateUpdateMs = nowMs;

        const duration = this.getDuration();
        if (!(duration > 0) || !isFinite(duration)) return;

        try {
            // setPositionState is not supported everywhere
            const ms = navigator.mediaSession as unknown as {
                setPositionState?: (state: { duration: number; playbackRate: number; position: number }) => void;
            };
            if (typeof ms.setPositionState === 'function') {
                ms.setPositionState({
                    duration,
                    playbackRate: this.rate,
                    position: Math.max(0, audio.currentTime ?? 0),
                });
            }
        } catch {
            // ignore
        }
    }

    private onAudioEnded(): void {
        const item = this.items[this.currentIndex];
        if (!item) {
            this.setStatus('stopped');
            return;
        }
        if (this.repeatMode === 'one') {
            const audio = this.audio;
            if (audio) {
                audio.currentTime = 0;
                audio.play().catch(() => {});
            }
            return;
        }
        const hasNext = this.currentIndex < this.items.length - 1;
        if (this.repeatMode === 'all' && !hasNext && this.items.length > 0) {
            this.loadItemByIndex(0);
            this.emitTrackChange();
            this.audio?.play().catch(() => {});
            return;
        }
        if (hasNext) {
            this.loadItemByIndex(this.currentIndex + 1);
            this.emitTrackChange();
            this.audio?.play().catch(() => {});
        } else {
            this.setStatus('stopped');
        }
    }

    private loadItemByIndex(index: number): void {
        if (index < 0 || index >= this.items.length) return;
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
        if (this.status === 'playing') {
            this.startMetadataPollingIfNeeded();
        }
    }

    private applyPlaybackRate(audio: HTMLAudioElement): void {
        // Per spec, calling `load()` resets `playbackRate` to `defaultPlaybackRate`.
        // Keep both in sync so rate survives track changes.
        audio.defaultPlaybackRate = this.rate;
        audio.playbackRate = this.rate;
    }

    private shuffleItems<T>(items: T[]): T[] {
        const arr = [...items];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    private buildShuffleQueueFromBase(desiredCurrentItemId?: string): QueueItem[] {
        if (this.baseItems.length === 0) return [];
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

    private rebuildEffectiveQueue(desiredCurrentItemId?: string): void {
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

    private resolveSrcForCompare(src: string): string {
        if (!src) return '';
        try {
            if (typeof document !== 'undefined' && document.baseURI) {
                return new URL(src, document.baseURI).href;
            }
            if (typeof window !== 'undefined' && window.location?.href) {
                return new URL(src, window.location.href).href;
            }
        } catch {
            // ignore
        }
        return src;
    }

    private updateMediaSessionMetadata(item: QueueItem): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: item.title || '',
                artist: item.artist || '',
                album: item.album || '',
                artwork: item.artwork
                    ? [{ src: item.artwork, sizes: '512x512', type: 'image/png' }]
                    : [],
            });
        } catch {
            // ignore
        }
    }

    private setupMediaSessionHandlers(): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
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
            } else {
                navigator.mediaSession.setActionHandler('stop', null);
            }
            if (opts.enableSeekTo) {
                navigator.mediaSession.setActionHandler('seekto', (details) => {
                    if (this.audio && typeof details?.seekTime === 'number') {
                        this.audio.currentTime = details.seekTime;
                        this.emitStateChange();
                        this.updatePositionState(true);
                    }
                });
            } else {
                navigator.mediaSession.setActionHandler('seekto', null);
            }
            if (opts.enableSkipForwardBackward) {
                const fwd = opts.skipForwardSeconds ?? 10;
                const bwd = opts.skipBackwardSeconds ?? 10;
                navigator.mediaSession.setActionHandler('seekforward', (details) => {
                    if (this.audio) {
                        const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : fwd;
                        this.audio.currentTime = Math.min(
                            this.audio.duration || Number.MAX_SAFE_INTEGER,
                            this.audio.currentTime + offset
                        );
                        this.emitStateChange();
                        this.updatePositionState(true);
                    }
                });
                navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                    if (this.audio) {
                        const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : bwd;
                        this.audio.currentTime = Math.max(0, this.audio.currentTime - offset);
                        this.emitStateChange();
                        this.updatePositionState(true);
                    }
                });
            } else {
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
            } else {
                navigator.mediaSession.setActionHandler('nexttrack', null);
                navigator.mediaSession.setActionHandler('previoustrack', null);
            }
        } catch {
            // some handlers may not be supported
        }
    }

    private getPosition(): number {
        return this.audio?.currentTime ?? 0;
    }

    private getDuration(): number {
        const d = this.audio?.duration;
        if (d != null && isFinite(d)) return d;
        const item = this.items[this.currentIndex];
        return item?.duration ?? 0;
    }

    private buildPlayerState(): PlayerState {
        return {
            stateRevision: this.stateRevision,
            queueRevision: this.queueRevision,
            status: this.status,
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
            position: this.getPosition(),
            duration: this.getDuration(),
            rate: this.rate,
            volume: this.volumePercent,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle,
        };
    }

    private emitStateChange(): void {
        this.stateRevision++;
        const state = this.buildPlayerState();
        this.stateChangeListeners.forEach((fn) => {
            try {
                fn(state);
            } catch {
                // ignore
            }
        });
    }

    private emitMetadataChange(itemId: string, metadata: Partial<QueueItem>): void {
        const event: MetadataChangeEvent = {
            stateRevision: this.stateRevision,
            itemId,
            metadata,
        };
        this.metadataChangeListeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                // ignore
            }
        });
    }

    private emitTrackChange(): void {
        const item = this.items[this.currentIndex];
        if (!item) return;
        const event: TrackChangeEvent = {
            queueRevision: this.queueRevision,
            currentIndex: this.currentIndex,
            item,
        };
        this.trackChangeListeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                // ignore
            }
        });
    }

    private emitQueueChange(): void {
        const event: QueueChangeEvent = {
            queueRevision: this.queueRevision,
            items: [...this.items],
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
        };
        this.queueChangeListeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                // ignore
            }
        });
    }

    private startStatePolling(): void {
        if (this.statePollTimer) return;
        this.statePollTimer = setInterval(() => {
            if (this.status === 'playing') this.emitStateChange();
        }, STATE_POLL_MS);
    }

    private stopStatePolling(): void {
        if (this.statePollTimer) {
            clearInterval(this.statePollTimer);
            this.statePollTimer = null;
        }
    }

    private createListenerHandle<T>(
        listeners: T[],
        fn: T
    ): PluginListenerHandle {
        listeners.push(fn);
        return {
            remove: async () => {
                const i = listeners.indexOf(fn);
                if (i !== -1) listeners.splice(i, 1);
            },
        };
    }

    // --- Queue ---

    async setQueue(params: SetQueueParams): Promise<void> {
        const token = this.bumpPlayToken();
        this.baseItems = params.items?.length ? [...params.items] : [];
        this.queueRevision++;
        const startIndex = Math.max(
            0,
            Math.min(params.startIndex ?? 0, Math.max(0, this.baseItems.length - 1))
        );
        const desiredCurrentItemId = this.baseItems[startIndex]?.id;
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
            } else {
                this.setStatus('stopped');
            }
        } else {
            audio.src = '';
            this.setStatus('stopped');
        }
        this.emitStateChange();
        this.emitQueueChange();
    }

    async syncQueue(params: SyncQueueParams): Promise<SyncQueueResult> {
        const force = params.force === true;
        if (
            params.expectedQueueRevision != null &&
            params.expectedQueueRevision !== this.queueRevision &&
            !force
        ) {
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

            const desiredCurrentItemId = params.currentItemId ?? this.items[this.currentIndex]?.id;
            const audio = this.audio;
            const newItems = params.items?.length ? [...params.items] : [];

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
                } catch {
                    // ignore autoplay failures
                }
            }

            return { queueRevision: this.queueRevision };
        }

        return { queueRevision: this.queueRevision };
    }

    async getQueue(): Promise<GetQueueResult> {
        return {
            queueRevision: this.queueRevision,
            items: [...this.items],
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
        };
    }

    async addQueueItems(params: AddQueueItemsParams): Promise<void> {
        if (this.baseItems.length === 0 && this.items.length > 0) {
            this.baseItems = [...this.items];
        }
        const beforeLength = this.baseItems.length;
        const desiredCurrentItemId = this.items[this.currentIndex]?.id;
        const insertItems = params.items ?? [];
        const atRaw = params.atIndex ?? this.baseItems.length;
        const at = Math.max(0, Math.min(atRaw, this.baseItems.length));

        this.baseItems.splice(at, 0, ...insertItems);
        this.rebuildEffectiveQueue(desiredCurrentItemId);

        // If queue was empty and now has items, initialize the current item (without autoplay).
        if (beforeLength === 0 && this.items.length > 0) {
            const desiredId = this.items[0]?.id;
            this.rebuildEffectiveQueue(desiredId);
            this.loadItemByIndex(this.currentIndex);
            this.setStatus('stopped');
        }

        this.queueRevision++;
        this.emitQueueChange();
        this.emitStateChange();
    }

    async removeQueueItem(params: RemoveQueueItemParams): Promise<void> {
        if (this.baseItems.length === 0 && this.items.length > 0) {
            this.baseItems = [...this.items];
        }
        const statusBefore = this.status;
        const oldItems = [...this.items];
        const oldIndex = this.currentIndex;
        const beforeCurrentItemId = oldItems[oldIndex]?.id;
        const removedWasCurrent = beforeCurrentItemId === params.itemId;

        const iBase = this.baseItems.findIndex((x) => x.id === params.itemId);
        if (iBase === -1) return;
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
        } else {
            // Current item removed: move to the next logical item (or previous if we were last).
            let candidateNextId: string | undefined;
            if (oldIndex < oldItems.length - 1) {
                candidateNextId = oldItems[oldIndex + 1]?.id;
            } else if (oldItems.length >= 2) {
                candidateNextId = oldItems[oldItems.length - 2]?.id;
            }

            this.rebuildEffectiveQueue(candidateNextId);
            this.loadItemByIndex(this.currentIndex);
            this.setStatus(statusBefore);
            if (statusBefore === 'playing') {
                void this.audio?.play();
            }
        }

        const afterCurrentItemId = this.items[this.currentIndex]?.id;
        if (beforeCurrentItemId && afterCurrentItemId && beforeCurrentItemId !== afterCurrentItemId) {
            this.emitTrackChange();
        }
        this.emitQueueChange();
        this.emitStateChange();
    }

    async moveQueueItem(params: MoveQueueItemParams): Promise<void> {
        if (this.baseItems.length === 0 && this.items.length > 0) {
            this.baseItems = [...this.items];
        }
        const { fromIndex, toIndex } = params;
        const desiredCurrentItemId = this.items[this.currentIndex]?.id;
        if (
            fromIndex < 0 ||
            fromIndex >= this.baseItems.length ||
            toIndex < 0 ||
            toIndex >= this.baseItems.length
        )
            return;
        const [item] = this.baseItems.splice(fromIndex, 1);
        this.baseItems.splice(toIndex, 0, item);
        this.queueRevision++;
        this.rebuildEffectiveQueue(desiredCurrentItemId);
        this.emitQueueChange();
        this.emitStateChange();
    }

    async clearQueue(): Promise<void> {
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

    private async playWithToken(token: number): Promise<void> {
        if (token !== this.playToken) return;
        try {
            await this.play();
        } catch {
            // ignore autoplay failures
        }
    }

    async play(): Promise<void> {
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
            if (token !== this.playToken) return;
            // ensure AudioContext gets a chance to resume after a user gesture
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                void this.audioCtx.resume().catch(() => {
                    // ignore
                });
            }
        } catch (err) {
            if (token !== this.playToken) return;
            // If play fails (e.g. user gesture), keep status consistent.
            if (this.status === 'playing') this.setStatus('paused');
            throw err instanceof Error ? err : new Error(String(err));
        }
    }

    async pause(): Promise<void> {
        this.audio?.pause();
        this.setStatus('paused');
    }

    async stop(): Promise<void> {
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

    async seek(params: SeekParams): Promise<void> {
        const audio = this.audio;
        if (!audio) return;
        audio.currentTime = Math.max(0, params.positionSeconds);
        this.emitStateChange();
        this.updatePositionState(true);
    }

    async skipToNext(): Promise<void> {
        if (this.items.length === 0) return;
        const nextIndex =
            this.currentIndex < this.items.length - 1
                ? this.currentIndex + 1
                : this.repeatMode === 'all'
                  ? 0
                  : this.currentIndex;
        if (nextIndex !== this.currentIndex) {
            this.loadItemByIndex(nextIndex);
            this.emitTrackChange();
            if (this.status === 'playing') this.audio?.play().catch(() => {});
        }
    }

    async skipToPrevious(): Promise<void> {
        if (this.items.length === 0) return;
        const audio = this.audio;
        const threshold = this.playbackOptions.previousThresholdSeconds ?? 7;
        const atStart = (audio?.currentTime ?? 0) <= threshold;
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
            if (this.status === 'playing') this.audio?.play().catch(() => {});
        } else if (audio) {
            audio.currentTime = 0;
            this.emitStateChange();
            this.updatePositionState(true);
        }
    }

    async skipToIndex(params: SkipToIndexParams): Promise<void> {
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
        if (this.status === 'playing') this.audio?.play().catch(() => {});
    }

    async setRate(params: SetRateParams): Promise<void> {
        this.rate = Math.max(0.5, Math.min(2, params.rate));
        if (this.audio) this.applyPlaybackRate(this.audio);
        this.emitStateChange();
        this.updatePositionState(true);
    }

    async setVolume(params: SetVolumeParams): Promise<void> {
        this.volumePercent = Math.max(0, Math.min(100, params.volume));
        this.ensureAudioGraph();
        if (this.gainNode && this.audioCtx) {
            this.applyGainVolume(this.volumePercent);
        } else if (this.audio) {
            this.audio.volume = this.volumePercent / 100;
        }
        this.emitStateChange();
    }

    // --- State ---

    async getState(): Promise<PlayerState> {
        return this.buildPlayerState();
    }

    // --- Progress / bookmarks (localStorage + in-memory cache on web) ---

    async setItemProgress(params: SetItemProgressParams): Promise<void> {
        const progress: ItemProgress = {
            itemId: params.itemId,
            positionSeconds: params.positionSeconds,
            durationSeconds: params.durationSeconds,
            completed: params.completed,
            updatedAtEpochMs: Date.now(),
        };
        this.progressMap.set(params.itemId, progress);
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(
                    `${ITEM_PROGRESS_STORAGE_PREFIX}${params.itemId}`,
                    JSON.stringify(progress)
                );
            }
        } catch {
            // ignore
        }
    }

    async getItemProgress(params: GetItemProgressParams): Promise<ItemProgress> {
        const stored = this.progressMap.get(params.itemId);
        if (stored) return stored;
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem(`${ITEM_PROGRESS_STORAGE_PREFIX}${params.itemId}`);
                if (raw) {
                    const parsed = JSON.parse(raw) as Partial<ItemProgress>;
                    if (
                        parsed &&
                        typeof parsed.itemId === 'string' &&
                        typeof parsed.positionSeconds === 'number' &&
                        typeof parsed.updatedAtEpochMs === 'number'
                    ) {
                        const progress: ItemProgress = {
                            itemId: parsed.itemId,
                            positionSeconds: parsed.positionSeconds,
                            durationSeconds:
                                typeof parsed.durationSeconds === 'number' ? parsed.durationSeconds : undefined,
                            completed: typeof parsed.completed === 'boolean' ? parsed.completed : undefined,
                            updatedAtEpochMs: parsed.updatedAtEpochMs,
                        };
                        this.progressMap.set(params.itemId, progress);
                        return progress;
                    }
                }
            }
        } catch {
            // ignore
        }
        const item = this.items.find((x) => x.id === params.itemId);
        const pos = item && this.items[this.currentIndex]?.id === params.itemId ? this.getPosition() : 0;
        const dur = item?.duration;
        return {
            itemId: params.itemId,
            positionSeconds: pos,
            durationSeconds: dur,
            completed: false,
            updatedAtEpochMs: Date.now(),
        };
    }

    // --- Options ---

    async setPlaybackOptions(params: SetPlaybackOptionsParams): Promise<void> {
        this.playbackOptions = { ...DEFAULT_PLAYBACK_OPTIONS, ...this.playbackOptions, ...params };
        this.setupMediaSessionHandlers();
    }

    async getPlaybackOptions(): Promise<PlaybackOptions> {
        return { ...this.playbackOptions };
    }

    async setRepeatMode(params: SetRepeatModeParams): Promise<void> {
        this.repeatMode = params.repeatMode;
        this.emitStateChange();
    }

    async setShuffle(params: SetShuffleParams): Promise<void> {
        if (this.shuffle === params.shuffle) return;
        const desiredCurrentItemId = this.items[this.currentIndex]?.id;
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

    private startMetadataPollingIfNeeded(): void {
        this.stopMetadataPolling();
        if (this.status !== 'playing') return;
        const item = this.items[this.currentIndex];
        if (!item?.metadataUpdateUrl) return;

        const url = String(item.metadataUpdateUrl);
        if (!url.trim()) return;

        const intervalSeconds = Math.max(5, item.metadataUpdateInterval ?? 15);
        this.metadataItemId = item.id;
        this.lastMetadataFingerprint = null;

        this.metadataTimer = setInterval(() => {
            void this.fetchAndApplyStreamMetadata(url, item.id, this.playToken);
        }, intervalSeconds * 1000);
    }

    private stopMetadataPolling(): void {
        if (this.metadataTimer) {
            clearInterval(this.metadataTimer);
            this.metadataTimer = null;
        }
        this.metadataItemId = null;
        this.lastMetadataFingerprint = null;
    }

    private async fetchAndApplyStreamMetadata(url: string, itemId: string, token: number): Promise<void> {
        if (token !== this.playToken) return;
        if (this.status !== 'playing') return;
        if (this.items[this.currentIndex]?.id !== itemId) return;

        let data: unknown;
        try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timeout = setTimeout(() => controller?.abort(), 5000);
            const res = await fetch(url, { signal: controller?.signal });
            clearTimeout(timeout);
            if (!res.ok) return;
            data = await res.json();
        } catch {
            return;
        }

        if (token !== this.playToken) return;
        if (this.items[this.currentIndex]?.id !== itemId) return;

        const obj = data as Record<string, unknown>;
        const title = typeof obj?.title === 'string' ? obj.title : undefined;
        const artist = typeof obj?.artist === 'string' ? obj.artist : undefined;
        const album = typeof obj?.album === 'string' ? obj.album : undefined;
        const artwork = typeof obj?.artwork === 'string' ? obj.artwork : undefined;

        if (!title && !artist && !album && !artwork) return;

        const fingerprint = `${title ?? ''}|${artist ?? ''}|${album ?? ''}|${artwork ?? ''}`;
        if (fingerprint === this.lastMetadataFingerprint) return;
        this.lastMetadataFingerprint = fingerprint;

        const current = this.items[this.currentIndex];
        if (!current) return;

        const changed: Partial<QueueItem> = {};
        if (title && title !== current.title) changed.title = title;
        if (artist && artist !== current.artist) changed.artist = artist;
        if (album && album !== current.album) changed.album = album;
        if (artwork && artwork !== current.artwork) changed.artwork = artwork;
        if (Object.keys(changed).length === 0) return;

        const updated = { ...current, ...changed };
        this.items[this.currentIndex] = updated;
        const baseIndex = this.baseItems.findIndex((x) => x.id === itemId);
        if (baseIndex !== -1) {
            this.baseItems[baseIndex] = { ...this.baseItems[baseIndex], ...changed };
        }
        this.updateMediaSessionMetadata(updated);

        // Emit state change first to bump stateRevision, then emit metadataChange with that revision.
        this.emitStateChange();
        this.emitMetadataChange(itemId, changed);
    }

    // --- Events ---

    async addListener(
        eventName: 'stateChange',
        listenerFunc: (state: PlayerState) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'trackChange',
        listenerFunc: (event: TrackChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'queueChange',
        listenerFunc: (event: QueueChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'metadataChange',
        listenerFunc: (event: MetadataChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'audioBecomingNoisy',
        listenerFunc: () => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: string,
        listenerFunc: (...args: any[]) => void
    ): Promise<PluginListenerHandle> {
        if (eventName === 'stateChange') {
            return this.createListenerHandle(this.stateChangeListeners, listenerFunc as (state: PlayerState) => void);
        }
        if (eventName === 'trackChange') {
            return this.createListenerHandle(this.trackChangeListeners, listenerFunc as (event: TrackChangeEvent) => void);
        }
        if (eventName === 'queueChange') {
            return this.createListenerHandle(this.queueChangeListeners, listenerFunc as (event: QueueChangeEvent) => void);
        }
        if (eventName === 'metadataChange') {
            return this.createListenerHandle(this.metadataChangeListeners, listenerFunc as (event: MetadataChangeEvent) => void);
        }
        if (eventName === 'audioBecomingNoisy') {
            return this.createListenerHandle(this.audioBecomingNoisyListeners, listenerFunc as () => void);
        }
        return Promise.reject(new Error(`Unknown event: ${eventName}`));
    }

    async removeAllListeners(): Promise<void> {
        this.stateChangeListeners = [];
        this.trackChangeListeners = [];
        this.queueChangeListeners = [];
        this.metadataChangeListeners = [];
        this.audioBecomingNoisyListeners = [];
    }
}

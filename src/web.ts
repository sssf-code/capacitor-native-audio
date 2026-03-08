import { WebPlugin } from '@capacitor/core';

import type {
    AudioPlayerPlugin,
    AddQueueItemsParams,
    GetItemProgressParams,
    GetQueueResult,
    ItemProgress,
    PlaybackOptions,
    PlaybackStatus,
    PlayerState,
    QueueItem,
    RemoveQueueItemParams,
    RepeatMode,
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
} from './definitions';

type ProgressMap = Map<string, ItemProgress>;

const DEFAULT_PLAYBACK_OPTIONS: PlaybackOptions = {
    previousThresholdSeconds: 7,
    skipForwardSeconds: 10,
    skipBackwardSeconds: 10,
    enableNextPrev: true,
    enableSeekTo: true,
    enableSkipForwardBackward: true,
    enableStop: true,
};

export class AudioPlayerWeb extends WebPlugin implements AudioPlayerPlugin {
    private audio: HTMLAudioElement | null = null;
    private queue: QueueItem[] = [];
    private currentIndex = 0;
    private stateRevision = 0;
    private queueRevision = 0;
    private status: PlaybackStatus = 'stopped';
    private rate = 1;
    private volume = 100; // 0..100
    private repeatMode: RepeatMode = 'off';
    private shuffle = false;
    private playbackOptions: PlaybackOptions = { ...DEFAULT_PLAYBACK_OPTIONS };
    private progress: ProgressMap = new Map();
    // Guard that suppresses 'play'/'pause' element event re-emissions when the
    // change was already initiated (and will be notified) by a public method.
    private internalOperation = false;

    private ensureAudio(): HTMLAudioElement {
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
            if (!this.audio || this.internalOperation) {
                return;
            }
            this.status = 'playing';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        });

        audio.addEventListener('pause', () => {
            if (!this.audio || this.internalOperation || this.status === 'stopped') {
                return;
            }
            this.status = 'paused';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        });

        this.audio = audio;
        return audio;
    }

    private bumpStateRevision() {
        this.stateRevision += 1;
    }

    private bumpQueueRevision() {
        this.queueRevision += 1;
    }

    private getCurrentItem(): QueueItem | undefined {
        if (this.currentIndex < 0 || this.currentIndex >= this.queue.length) {
            return undefined;
        }
        return this.queue[this.currentIndex];
    }

    private updateMediaSessionMetadata(item: QueueItem | undefined) {
        if (typeof navigator === 'undefined') {
            return;
        }
        const anyNavigator = navigator as Navigator & {
            mediaSession?: MediaSession;
        };
        if (!anyNavigator.mediaSession) {
            return;
        }
        if (!item) {
            anyNavigator.mediaSession.metadata = null;
            return;
        }

        try {
            anyNavigator.mediaSession.metadata = new MediaMetadata({
                title: item.title ?? '',
                artist: item.artist ?? '',
                album: item.album ?? '',
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

            this.updateMediaSessionHandlers(anyNavigator.mediaSession);
        } catch {
            // Media Session is best-effort only
        }
    }

    private updateMediaSessionHandlers(mediaSession?: MediaSession) {
        if (typeof navigator === 'undefined') {
            return;
        }
        const anyNavigator = navigator as Navigator & {
            mediaSession?: MediaSession;
        };
        const session = mediaSession ?? anyNavigator.mediaSession;
        if (!session) {
            return;
        }

        const opts = this.playbackOptions ?? ({} as PlaybackOptions);

        try {
            // Basic play/pause handlers are always enabled.
            session.setActionHandler('play', async () => {
                await this.play();
            });
            session.setActionHandler('pause', async () => {
                await this.pause();
            });

            // Stop
            if (opts.enableStop === false) {
                session.setActionHandler('stop', null);
            } else {
                session.setActionHandler('stop', async () => {
                    await this.stop();
                });
            }

            // SeekTo
            if (opts.enableSeekTo === false) {
                session.setActionHandler('seekto', null);
            } else {
                session.setActionHandler('seekto', async details => {
                    if (typeof details.seekTime === 'number') {
                        await this.seek({ positionSeconds: details.seekTime });
                    }
                });
            }

            // Skip backward/forward
            if (opts.enableSkipForwardBackward === false) {
                session.setActionHandler('seekbackward', null);
                session.setActionHandler('seekforward', null);
            } else {
                session.setActionHandler('seekbackward', async details => {
                    const offset =
                        typeof details.seekOffset === 'number'
                            ? details.seekOffset
                            : this.playbackOptions.skipBackwardSeconds;
                    const state = await this.getState();
                    const target = Math.max(0, state.position - offset);
                    await this.seek({ positionSeconds: target });
                });
                session.setActionHandler('seekforward', async details => {
                    const offset =
                        typeof details.seekOffset === 'number'
                            ? details.seekOffset
                            : this.playbackOptions.skipForwardSeconds;
                    const state = await this.getState();
                    const duration = state.duration ?? Number.MAX_SAFE_INTEGER;
                    const target = Math.min(duration, state.position + offset);
                    await this.seek({ positionSeconds: target });
                });
            }

            // Previous/next track
            if (opts.enableNextPrev === false) {
                session.setActionHandler('previoustrack', null);
                session.setActionHandler('nexttrack', null);
            } else {
                session.setActionHandler('previoustrack', async () => {
                    await this.skipToPrevious();
                });
                session.setActionHandler('nexttrack', async () => {
                    await this.skipToNext();
                });
            }
        } catch {
            // Media Session is best-effort only
        }
    }

    private async loadCurrent(autoplay: boolean, startPositionSeconds: number | undefined) {
        const item = this.getCurrentItem();
        if (!item) {
            return;
        }

        const audio = this.ensureAudio();

        this.internalOperation = true;
        try {
            audio.pause();
            audio.currentTime = 0;
            audio.src = item.src;
        } finally {
            this.internalOperation = false;
        }

        audio.playbackRate = this.rate;
        audio.volume = this.volume / 100;

        this.updateMediaSessionMetadata(item);

        await new Promise<void>((resolve, reject) => {
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
            } catch (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });

        if (typeof startPositionSeconds === 'number' && startPositionSeconds > 0) {
            audio.currentTime = startPositionSeconds;
        }

        this.notifyStateFromElement();

        if (autoplay) {
            this.internalOperation = true;
            try {
                await audio.play();
            } finally {
                this.internalOperation = false;
            }
            this.status = 'playing';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        } else {
            this.status = 'stopped';
            this.bumpStateRevision();
            this.notifyListeners('stateChange', this.buildState());
        }

        this.notifyListeners('trackChange', {
            queueRevision: this.queueRevision,
            currentIndex: this.currentIndex,
            item,
        });
    }

    private handleEnded() {
        const item = this.getCurrentItem();
        const now = Date.now();
        if (item) {
            const existing = this.progress.get(item.id);
            const durationSeconds = this.audio?.duration ?? existing?.durationSeconds ?? 0;
            this.progress.set(item.id, {
                itemId: item.id,
                positionSeconds: durationSeconds,
                durationSeconds,
                completed: true,
                updatedAtEpochMs: now,
            });
        }

        if (this.repeatMode === 'one') {
            void this.seek({ positionSeconds: 0 }).then(() => this.play());
            return;
        }

        const lastIndex = this.queue.length - 1;
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

    private notifyStateFromElement() {
        if (!this.audio) {
            return;
        }
        this.bumpStateRevision();
        this.notifyListeners('stateChange', this.buildState());
    }

    private buildState(): PlayerState {
        const audio = this.audio;
        const position = audio?.currentTime ?? 0;
        const duration = audio?.duration;

        return {
            stateRevision: this.stateRevision,
            queueRevision: this.queueRevision,
            status: this.status,
            currentIndex: this.currentIndex,
            currentItemId: this.getCurrentItem()?.id,
            position,
            duration: Number.isFinite(duration ?? NaN) ? duration : undefined,
            rate: this.rate,
            volume: this.volume,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle,
        };
    }

    // Queue

    async setQueue(params: SetQueueParams): Promise<void> {
        const { items, startIndex = 0, startPositionSeconds = 0, autoplay } = params;
        this.queue = [...items];

        if (this.queue.length === 0) {
            this.currentIndex = 0;
            this.bumpQueueRevision();
            if (this.audio) {
                this.internalOperation = true;
                try {
                    this.audio.pause();
                    this.audio.removeAttribute('src');
                    this.audio.load();
                } finally {
                    this.internalOperation = false;
                }
            }
            await this.notifyListeners('queueChange', await this.getQueue());
            return;
        }

        this.currentIndex = Math.max(0, Math.min(startIndex, this.queue.length - 1));
        this.bumpQueueRevision();
        await this.loadCurrent(autoplay ?? false, startPositionSeconds);
        await this.notifyListeners('queueChange', await this.getQueue());
    }

    async syncQueue(params: SyncQueueParams): Promise<SyncQueueResult> {
        const mode = params.mode ?? 'replace';

        if (
            typeof params.expectedQueueRevision === 'number' &&
            params.expectedQueueRevision !== this.queueRevision
        ) {
            throw new Error(
                `Queue revision mismatch: expected ${params.expectedQueueRevision}, got ${this.queueRevision}`,
            );
        }

        if (mode === 'replace') {
            await this.setQueue(params);
            return { queueRevision: this.queueRevision };
        }

        if (mode === 'patch') {
            const {
                items,
                startIndex = 0,
                startPositionSeconds = 0,
                autoplay,
                currentItemId,
            } = params;

            // Try to preserve the current item if it still exists in the new queue.
            // This intentionally references the pre-update current item to maintain
            // playback continuity when the same item appears in the refreshed queue.
            const previousItemId = currentItemId ?? this.getCurrentItem()?.id;

            this.queue = [...items];

            if (this.queue.length === 0) {
                this.currentIndex = 0;
                this.bumpQueueRevision();
                if (this.audio) {
                    this.internalOperation = true;
                    try {
                        this.audio.pause();
                        this.audio.removeAttribute('src');
                        this.audio.load();
                    } finally {
                        this.internalOperation = false;
                    }
                }
                await this.notifyListeners('queueChange', await this.getQueue());
                return { queueRevision: this.queueRevision };
            }

            let targetIndex = startIndex;
            if (previousItemId) {
                const preservedIndex = this.queue.findIndex(item => item.id === previousItemId);
                if (preservedIndex !== -1) {
                    targetIndex = preservedIndex;
                }
            }

            this.currentIndex = Math.max(0, Math.min(targetIndex, this.queue.length - 1));
            this.bumpQueueRevision();
            await this.loadCurrent(autoplay ?? false, startPositionSeconds);
            await this.notifyListeners('queueChange', await this.getQueue());
            return { queueRevision: this.queueRevision };
        }

        throw new Error(`Unsupported syncQueue mode: ${String(mode)}`);
    }

    async getQueue(): Promise<GetQueueResult> {
        return {
            queueRevision: this.queueRevision,
            items: [...this.queue],
            currentIndex: this.currentIndex,
            currentItemId: this.getCurrentItem()?.id,
        };
    }

    async addQueueItems(params: AddQueueItemsParams): Promise<void> {
        const { items, atIndex } = params;
        if (typeof atIndex === 'number' && atIndex >= 0 && atIndex <= this.queue.length) {
            this.queue.splice(atIndex, 0, ...items);
            if (this.currentIndex >= atIndex) {
                this.currentIndex += items.length;
            }
        } else {
            this.queue.push(...items);
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }

    async removeQueueItem(params: RemoveQueueItemParams): Promise<void> {
        const idx = this.queue.findIndex(it => it.id === params.itemId);
        if (idx === -1) {
            return;
        }
        this.queue.splice(idx, 1);
        if (this.currentIndex > idx) {
            this.currentIndex -= 1;
        } else if (this.currentIndex === idx) {
            if (this.queue.length === 0) {
                this.currentIndex = 0;
                await this.stop();
            } else {
                this.currentIndex = Math.min(this.currentIndex, this.queue.length - 1);
                await this.loadCurrent(false, 0);
            }
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }

    async moveQueueItem(params: MoveQueueItemParams): Promise<void> {
        const { fromIndex, toIndex } = params;
        if (
            fromIndex < 0 ||
            fromIndex >= this.queue.length ||
            toIndex < 0 ||
            toIndex >= this.queue.length
        ) {
            return;
        }
        const [item] = this.queue.splice(fromIndex, 1);
        this.queue.splice(toIndex, 0, item);
        if (this.currentIndex === fromIndex) {
            this.currentIndex = toIndex;
        } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
            this.currentIndex -= 1;
        } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
            this.currentIndex += 1;
        }
        this.bumpQueueRevision();
        await this.notifyListeners('queueChange', await this.getQueue());
    }

    async clearQueue(): Promise<void> {
        if (this.audio) {
            this.internalOperation = true;
            try {
                this.audio.pause();
                this.audio.currentTime = 0;
                this.audio.src = '';
            } finally {
                this.internalOperation = false;
            }
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

    async play(): Promise<void> {
        if (!this.getCurrentItem() && this.queue.length > 0) {
            this.currentIndex = 0;
            await this.loadCurrent(false, 0);
        }

        const audio = this.ensureAudio();
        this.internalOperation = true;
        try {
            await audio.play();
        } catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        } finally {
            this.internalOperation = false;
        }
        this.status = 'playing';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    async pause(): Promise<void> {
        if (!this.audio) {
            return;
        }
        this.internalOperation = true;
        try {
            this.audio.pause();
        } finally {
            this.internalOperation = false;
        }
        this.status = 'paused';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    async stop(): Promise<void> {
        if (!this.audio) {
            return;
        }
        this.internalOperation = true;
        try {
            this.audio.pause();
            this.audio.currentTime = 0;
        } finally {
            this.internalOperation = false;
        }
        this.status = 'stopped';
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    async seek(params: SeekParams): Promise<void> {
        const audio = this.ensureAudio();
        const target = Math.max(0, params.positionSeconds);
        try {
            audio.currentTime = target;
        } catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
        }
        this.notifyStateFromElement();
    }

    private async skipToPreviousInternal(): Promise<void> {
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

    async skipToNext(): Promise<void> {
        if (this.currentIndex >= this.queue.length - 1) {
            // Already at the last item -- no-op, matching native behavior.
            return;
        }
        this.currentIndex += 1;
        await this.loadCurrent(true, 0);
    }

    // Methods required by the interface

    async skipToPrevious(): Promise<void> {
        await this.skipToPreviousInternal();
    }

    async skipToIndex(params: SkipToIndexParams): Promise<void> {
        const index = Math.max(0, Math.min(params.index, this.queue.length - 1));
        this.currentIndex = index;
        await this.loadCurrent(true, params.positionSeconds ?? 0);
    }

    async setRate(params: SetRateParams): Promise<void> {
        const clamped = Math.max(0.25, Math.min(4, params.rate));
        this.rate = clamped;
        if (this.audio) {
            this.audio.playbackRate = clamped;
        }
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    async setVolume(params: SetVolumeParams): Promise<void> {
        const vol = Math.max(0, Math.min(100, params.volume));
        this.volume = vol;
        if (this.audio) {
            this.audio.volume = vol / 100;
        }
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    async getState(): Promise<PlayerState> {
        return this.buildState();
    }

    // Progress / bookmarks

    setItemProgress(params: SetItemProgressParams): Promise<void> {
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

    getItemProgress(params: GetItemProgressParams): Promise<ItemProgress> {
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

    async setPlaybackOptions(params: SetPlaybackOptionsParams): Promise<void> {
        this.playbackOptions = {
            ...this.playbackOptions,
            ...params,
        };
        this.updateMediaSessionHandlers();
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    getPlaybackOptions(): Promise<PlaybackOptions> {
        return Promise.resolve(this.playbackOptions);
    }

    // Playback modes

    async setRepeatMode(params: SetRepeatModeParams): Promise<void> {
        this.repeatMode = params.repeatMode;
        this.bumpStateRevision();
        await this.notifyListeners('stateChange', this.buildState());
    }

    setShuffle(_params: SetShuffleParams): Promise<void> {
        // Shuffle playback is not implemented for the web platform.
        // Explicitly reject so callers can handle the lack of support.
        return Promise.reject(new Error('Shuffle playback is not supported on the web platform.'));
    }
}

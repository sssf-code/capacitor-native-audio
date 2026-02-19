import type { CapacitorException } from '@capacitor/core';
import { AudioPlayer, type PlayerState, type QueueItem } from '@ssf/capacitor-native-audio';

const newsHref = new URL('/assets/karen_the_news_update.mp3', import.meta.url).href;
const bicycleHref = new URL('/assets/komiku_bicycle.mp3', import.meta.url).href;

const audiobookQueue: QueueItem[] = [
    {
        id: 'chapter-1',
        src: newsHref,
        title: 'Chapter 1',
        artist: 'Example',
        album: 'Example Audiobook',
        artwork: 'assets/sample_artwork.png',
    },
    {
        id: 'chapter-2',
        src: bicycleHref,
        title: 'Chapter 2',
        artist: 'Example',
        album: 'Example Audiobook',
        artwork: 'assets/sample_artwork.png',
    },
    {
        id: 'chapter-3',
        src: newsHref,
        title: 'Chapter 3',
        artist: 'Example',
        album: 'Example Audiobook',
        artwork: 'assets/sample_artwork.png',
    },
];

const podcastQueue: QueueItem[] = [
    {
        id: 'ep-101',
        src: newsHref,
        title: 'Episode 101',
        artist: 'Example Show',
        album: 'Example Podcast',
        artwork: 'assets/sample_artwork.png',
    },
    {
        id: 'ep-102',
        src: bicycleHref,
        title: 'Episode 102',
        artist: 'Example Show',
        album: 'Example Podcast',
        artwork: 'assets/sample_artwork.png',
    },
];

let lastState: PlayerState | null = null;

async function init(): Promise<void> {
    AudioPlayer.addListener('stateChange', state => {
        lastState = state;
        render();
    });
    AudioPlayer.addListener('queueChange', q => {
        void q;
        render();
    });
    AudioPlayer.addListener('trackChange', () => {
        void resync();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void resync();
        }
    });

    addClickEvent('loadAudiobookQueue', () => void loadQueue(audiobookQueue));
    addClickEvent('loadPodcastQueue', () => void loadQueue(podcastQueue));
    addClickEvent('patchSyncButton', () => void patchSync(false));
    addClickEvent('patchSyncMismatchButton', () => void patchSync(true));
    addClickEvent('resyncButton', () => void resync());
    addClickEvent('clearQueueButton', () => void AudioPlayer.clearQueue().catch(setError));

    addClickEvent('playButton', () => void AudioPlayer.play().catch(setError));
    addClickEvent('pauseButton', () => void AudioPlayer.pause().catch(setError));
    addClickEvent('stopButton', () => void AudioPlayer.stop().catch(setError));
    addClickEvent('nextButton', () => void AudioPlayer.skipToNext().catch(setError));
    addClickEvent('prevButton', () => void AudioPlayer.skipToPrevious().catch(setError));

    addClickEvent('addItemButton', () => void addOneItem());
    addClickEvent('removeCurrentButton', () => void removeCurrentItem());
    addClickEvent('moveLastToFirstButton', () => void moveLastToFirst());
    addClickEvent('repeatButton', () => void cycleRepeatMode());
    addClickEvent('shuffleButton', () => void toggleShuffle());

    // Set some options to make OS controls nicer.
    await AudioPlayer.setPlaybackOptions({
        previousThresholdSeconds: 8,
        skipForwardSeconds: 10,
        skipBackwardSeconds: 10,
        enableNextPrev: true,
        enableSeekTo: true,
        enableStop: true,
    }).catch(setError);

    await resync();
}

async function cycleRepeatMode(): Promise<void> {
    const state = await AudioPlayer.getState().catch(() => null);
    const current = state?.repeatMode ?? 'off';
    const next = current === 'off' ? 'one' : current === 'one' ? 'all' : 'off';
    await AudioPlayer.setRepeatMode({ repeatMode: next }).catch(setError);
    await resync();
}

async function toggleShuffle(): Promise<void> {
    const state = await AudioPlayer.getState().catch(() => null);
    const next = !(state?.shuffle ?? false);
    await AudioPlayer.setShuffle({ shuffle: next }).catch(setError);
    await resync();
}

async function patchSync(forceMismatch: boolean): Promise<void> {
    const q = await AudioPlayer.getQueue().catch(() => null);
    if (!q) return;

    const expected = forceMismatch ? q.queueRevision + 9999 : q.queueRevision;
    const items = q.items.map(it => ({
        ...it,
        title: `${it.title} (patched)`,
    }));

    await AudioPlayer.syncQueue({
        items,
        mode: 'patch',
        expectedQueueRevision: expected,
        force: false,
        autoplay: false,
        currentItemId: q.currentItemId,
    }).catch(setError);

    await resync();
}

async function loadQueue(items: QueueItem[]): Promise<void> {
    // Resume from bookmark for the first item (audiobook-friendly).
    const firstId = items[0]?.id;
    let startPos = 0;
    if (firstId) {
        const prog = await AudioPlayer.getItemProgress({ itemId: firstId }).catch(() => null);
        if (prog?.positionSeconds) startPos = prog.positionSeconds;
    }

    await AudioPlayer.setQueue({
        items,
        startIndex: 0,
        startPositionSeconds: startPos,
        autoplay: false,
    }).catch(setError);

    await resync();
}

async function addOneItem(): Promise<void> {
    const id = `extra-${Math.floor(Math.random() * 1e9)}`;
    await AudioPlayer.addQueueItems({
        items: [
            {
                id,
                src: bicycleHref,
                title: `Extra item (${id})`,
                artist: 'Example',
                album: 'Dynamic Queue',
                artwork: 'assets/sample_artwork.png',
            },
        ],
    }).catch(setError);
    await resync();
}

async function removeCurrentItem(): Promise<void> {
    const state = await AudioPlayer.getState().catch(() => null);
    const itemId = state?.currentItemId;
    if (!itemId) return;
    await AudioPlayer.removeQueueItem({ itemId }).catch(setError);
    await resync();
}

async function moveLastToFirst(): Promise<void> {
    const q = await AudioPlayer.getQueue().catch(() => null);
    if (!q || q.items.length < 2) return;
    await AudioPlayer.moveQueueItem({ fromIndex: q.items.length - 1, toIndex: 0 }).catch(setError);
    await resync();
}

async function resync(): Promise<void> {
    const state = await AudioPlayer.getState().catch(() => null);
    if (state) lastState = state;
    render();
}

function render(): void {
    const s = lastState;
    setText('status', s?.status ?? 'stopped');
    setText('stateRevision', `${s?.stateRevision ?? 0}`);
    setText('queueRevision', `${s?.queueRevision ?? 0}`);
    setText('currentIndex', `${s?.currentIndex ?? 0}`);
    setText('currentItemId', s?.currentItemId ?? '-');
    setText('position', `${Math.floor(s?.position ?? 0)}`);
    setText('duration', s?.duration != null ? `${Math.floor(s.duration)}` : '-');
    setText('rate', `${s?.rate ?? 1}`);
    setText('volume', `${s?.volume ?? 100}`);

    const repeatLabel = s?.repeatMode ?? 'off';
    setText('repeatButton', `Repeat: ${repeatLabel}`);
    setText('shuffleButton', `Shuffle: ${(s?.shuffle ?? false) ? 'on' : 'off'}`);
}

function addClickEvent(elementId: string, callback: () => void): void {
    const el = document.getElementById(elementId);
    if (el) el.onclick = callback;
}

function setError(exception: unknown) {
    const ex = exception as CapacitorException;
    setText('error', ex?.message ?? String(exception));
}

function setText(elementId: string, text: string): void {
    const el = document.getElementById(elementId);
    if (el) el.innerText = text;
}

void init();


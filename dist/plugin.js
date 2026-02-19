var capacitorAudioPlayer = (function (exports, core) {
    'use strict';

    const AudioPlayer = core.registerPlugin('AudioPlayer', {
        web: () => Promise.resolve().then(function () { return web; }).then(m => new m.AudioPlayerWeb()),
    });

    class AudioPlayerWeb extends core.WebPlugin {
        setQueue(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        syncQueue(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        getQueue() {
            throw this.unimplemented('Not implemented on web.');
        }
        addQueueItems(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        removeQueueItem(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        moveQueueItem(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        clearQueue() {
            throw this.unimplemented('Not implemented on web.');
        }
        play() {
            throw this.unimplemented('Not implemented on web.');
        }
        pause() {
            throw this.unimplemented('Not implemented on web.');
        }
        stop() {
            throw this.unimplemented('Not implemented on web.');
        }
        seek(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        skipToNext() {
            throw this.unimplemented('Not implemented on web.');
        }
        skipToPrevious() {
            throw this.unimplemented('Not implemented on web.');
        }
        skipToIndex(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        setRate(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        setVolume(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        getState() {
            throw this.unimplemented('Not implemented on web.');
        }
        setItemProgress(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        getItemProgress(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        setPlaybackOptions(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        getPlaybackOptions() {
            throw this.unimplemented('Not implemented on web.');
        }
        setRepeatMode(params) {
            throw this.unimplemented('Not implemented on web.');
        }
        setShuffle(params) {
            throw this.unimplemented('Not implemented on web.');
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

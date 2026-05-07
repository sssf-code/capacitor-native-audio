import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

final class NativeQueuePlayer {
    private weak var plugin: AudioPlayerPlugin?
    private let store: QueueStore

    private let player = AVQueuePlayer()
    private var timeObserver: Any?
    private var currentItemObservation: NSKeyValueObservation?

    private(set) var queue: [QueueItem] = []
    private var baseQueue: [QueueItem] = []
    private var shuffleQueue: [QueueItem]? = nil
    private var playerItemsByIndex: [Int: AVPlayerItem] = [:]
    private var progressByItemId: [String: ItemProgress] = [:]

    private(set) var state = PlayerState()
    private(set) var options = PlaybackOptions()

    private var isRestoring = false
    private var isStopped = true

    private var metadataTimer: DispatchSourceTimer?
    private var lastMetadataFingerprintByItemId: [String: String] = [:]

    // Remote command targets (so we can remove them on teardown).
    private var playCommandTarget: Any?
    private var pauseCommandTarget: Any?
    private var nextTrackCommandTarget: Any?
    private var previousTrackCommandTarget: Any?
    private var changePlaybackPositionCommandTarget: Any?
    private var skipForwardCommandTarget: Any?
    private var skipBackwardCommandTarget: Any?
    private var stopCommandTarget: Any?

    private var isReleased = false

    private let seekTimescale: CMTimeScale = 600

    init(plugin: AudioPlayerPlugin, store: QueueStore = QueueStore()) {
        self.plugin = plugin
        self.store = store
        player.actionAtItemEnd = .none

        setupAudioSession()
        setupRemoteCommands()
        setupObservers()
        restoreIfAvailable()
    }

    func release() {
        if isReleased { return }
        isReleased = true

        stopMetadataPolling()
        teardownObservers()

        // Remove remote command targets.
        let commandCenter = MPRemoteCommandCenter.shared()
        if let target = playCommandTarget { commandCenter.playCommand.removeTarget(target) }
        if let target = pauseCommandTarget { commandCenter.pauseCommand.removeTarget(target) }
        if let target = nextTrackCommandTarget { commandCenter.nextTrackCommand.removeTarget(target) }
        if let target = previousTrackCommandTarget { commandCenter.previousTrackCommand.removeTarget(target) }
        if let target = changePlaybackPositionCommandTarget {
            commandCenter.changePlaybackPositionCommand.removeTarget(target)
        }
        if let target = skipForwardCommandTarget { commandCenter.skipForwardCommand.removeTarget(target) }
        if let target = skipBackwardCommandTarget { commandCenter.skipBackwardCommand.removeTarget(target) }
        if let target = stopCommandTarget { commandCenter.stopCommand.removeTarget(target) }

        playCommandTarget = nil
        pauseCommandTarget = nil
        nextTrackCommandTarget = nil
        previousTrackCommandTarget = nil
        changePlaybackPositionCommandTarget = nil
        skipForwardCommandTarget = nil
        skipBackwardCommandTarget = nil
        stopCommandTarget = nil

        // Clear now playing (best-effort).
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: - Public API

    func setQueue(items: [QueueItem], startIndex: Int?, startPositionSeconds: Double?, autoplay: Bool?) {
        let idx = startIndex ?? 0
        let pos = startPositionSeconds ?? 0
        baseQueue = items
        if state.shuffle {
            shuffleQueue = buildInitialShuffleQueue(from: baseQueue, currentItemId: items.indices.contains(idx) ? items[idx].id : nil)
        } else {
            shuffleQueue = nil
        }
        let effective = resolvedEffectiveQueue()
        rebuildQueue(items: effective, desiredItemId: nil, desiredIndex: idx, desiredPositionSeconds: pos, shouldBumpQueueRevision: true)
        if autoplay == true { play() }
    }

    func syncQueue(mode: String, items: [QueueItem], currentItemId: String?, startIndex: Int?, startPositionSeconds: Double?, autoplay: Bool?) {
        let desiredId = currentItemId ?? state.currentItemId
        baseQueue = items
        // If shuffle is enabled, always rebuild from base (patch semantics become ambiguous).
        if state.shuffle {
            shuffleQueue = buildInitialShuffleQueue(from: baseQueue, currentItemId: desiredId)
            let effective = resolvedEffectiveQueue()
            rebuildQueue(items: effective, desiredItemId: desiredId, desiredIndex: startIndex, desiredPositionSeconds: startPositionSeconds, shouldBumpQueueRevision: true)
            if autoplay == true { play() }
            return
        }
        shuffleQueue = nil

        // If caller specified explicit start index/position, treat as replace.
        if startIndex != nil || startPositionSeconds != nil {
            rebuildQueue(
                items: items,
                desiredItemId: desiredId,
                desiredIndex: startIndex,
                desiredPositionSeconds: startPositionSeconds,
                shouldBumpQueueRevision: true
            )
            if autoplay == true { play() }
            return
        }

        if mode == "patch" {
            if patchQueuePreservingCurrentItem(newItems: items, desiredCurrentItemId: desiredId) {
                if autoplay == true { play() }
                return
            }
        }

        rebuildQueue(items: items, desiredItemId: desiredId, desiredIndex: nil, desiredPositionSeconds: nil, shouldBumpQueueRevision: true)
        if autoplay == true { play() }
    }

    func getQueueResult() -> [String: Any] {
        [
            "queueRevision": state.queueRevision,
            "items": queue.map(queueItemToJS),
            "currentIndex": state.currentIndex,
            "currentItemId": state.currentItemId as Any
        ]
    }

    func addQueueItems(items: [QueueItem], atIndex: Int?) {
        var updated = baseQueue
        let insertion = max(0, min(atIndex ?? updated.count, updated.count))
        updated.insert(contentsOf: items, at: insertion)

        // Preserve current item by id if possible.
        let desiredId = state.currentItemId
        baseQueue = updated
        if state.shuffle {
            shuffleQueue = rebuildShuffleQueueAfterBaseChange(currentItemId: desiredId)
        }
        let effective = resolvedEffectiveQueue()
        rebuildQueue(items: effective, desiredItemId: desiredId, desiredIndex: nil, desiredPositionSeconds: nil, shouldBumpQueueRevision: true)
    }

    func removeQueueItem(itemId: String) {
        let desiredId = state.currentItemId
        let updated = baseQueue.filter { $0.id != itemId }
        baseQueue = updated
        if state.shuffle {
            shuffleQueue = rebuildShuffleQueueAfterBaseChange(currentItemId: desiredId)
        }
        let effective = resolvedEffectiveQueue()
        rebuildQueue(items: effective, desiredItemId: desiredId, desiredIndex: nil, desiredPositionSeconds: nil, shouldBumpQueueRevision: true)
    }

    func moveQueueItem(fromIndex: Int, toIndex: Int) {
        guard baseQueue.indices.contains(fromIndex) else { return }
        var updated = baseQueue
        let item = updated.remove(at: fromIndex)
        let insertion = max(0, min(toIndex, updated.count))
        updated.insert(item, at: insertion)
        let desiredId = state.currentItemId
        baseQueue = updated
        if state.shuffle {
            shuffleQueue = rebuildShuffleQueueAfterBaseChange(currentItemId: desiredId)
        }
        let effective = resolvedEffectiveQueue()
        rebuildQueue(items: effective, desiredItemId: desiredId, desiredIndex: nil, desiredPositionSeconds: nil, shouldBumpQueueRevision: true)
    }

    func clearQueue() {
        stopMetadataPolling()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        queue = []
        baseQueue = []
        shuffleQueue = nil
        playerItemsByIndex = [:]
        player.removeAllItems()
        state.currentIndex = 0
        state.currentItemId = nil
        state.position = 0
        state.duration = nil
        state.status = .stopped
        state.playlistFinished = nil
        isStopped = true

        bumpQueueRevision()
        persist()
        notifyQueueChange()
        notifyStateChange()
        refreshNowPlaying()
    }

    func play() {
        guard !queue.isEmpty else { return }
        
        // Activate audio session when actually starting playback (avoid interrupting others on plugin init).
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Continue anyway; playback may still work.
        }
        isStopped = false
        player.playImmediately(atRate: Float(state.rate))
        state.status = .playing
        bumpStateRevision()
        persist()
        notifyStateChange()
        refreshNowPlaying()
        startMetadataPollingIfNeeded()
    }

    func pause() {
        player.pause()
        state.status = .paused
        bumpStateRevision()
        persist()
        notifyStateChange()
        refreshNowPlaying()
        stopMetadataPolling()
    }

    func stop() {
        player.pause()
        if player.currentItem != nil {
            player.seek(to: .zero)
        }
        isStopped = true
        state.status = .stopped
        state.position = 0
        
        // Best-effort: release audio session so other audio can resume.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        bumpStateRevision()
        persist()
        notifyStateChange()
        refreshNowPlaying()
        stopMetadataPolling()
    }

    func seek(positionSeconds: Double) {
        let pos = max(0, positionSeconds)
        player.seek(to: CMTime(seconds: pos, preferredTimescale: seekTimescale))
        state.position = pos
        bumpStateRevision()
        persist()
        notifyStateChange()
        refreshNowPlayingPositionOnly()
    }

    func skipToNext() {
        guard state.currentIndex + 1 < queue.count else { return }
        skipToIndex(state.currentIndex + 1, positionSeconds: 0)
    }

    func skipToPrevious() {
        if state.position > options.previousThresholdSeconds {
            seek(positionSeconds: 0)
            return
        }
        guard state.currentIndex - 1 >= 0 else {
            seek(positionSeconds: 0)
            return
        }
        skipToIndex(state.currentIndex - 1, positionSeconds: 0)
    }

    func skipToIndex(_ index: Int, positionSeconds: Double?) {
        guard !queue.isEmpty else { return }
        let clamped = max(0, min(index, queue.count - 1))
        let pos = max(0, positionSeconds ?? 0)
        let wasPlaying = (state.status == .playing)
        rebuildQueue(items: queue, desiredItemId: queue[clamped].id, desiredIndex: clamped, desiredPositionSeconds: pos, shouldBumpQueueRevision: false)
        if wasPlaying { play() }
    }

    func setRate(_ rate: Double) {
        let r = max(0.25, min(rate, 4.0))
        state.rate = r
        if state.status == .playing {
            player.rate = Float(r)
        }
        bumpStateRevision()
        persist()
        notifyStateChange()
        refreshNowPlayingPositionOnly()
    }

    func setVolume(_ volume: Double) {
        // volume is 0..100 externally; AVPlayer uses 0..1
        let v = max(0, min(volume, 100))
        state.volume = v
        player.volume = Float(v / 100.0)
        bumpStateRevision()
        persist()
        notifyStateChange()
    }

    func getStateResult() -> [String: Any] {
        stateToJS()
    }

    func setItemProgress(itemId: String, positionSeconds: Double, durationSeconds: Double?, completed: Bool?) {
        let prog = ItemProgress(
            itemId: itemId,
            positionSeconds: max(0, positionSeconds),
            durationSeconds: durationSeconds,
            completed: completed,
            updatedAtEpochMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        progressByItemId[itemId] = prog
        bumpStateRevision()
        persist()
    }

    func getItemProgress(itemId: String) -> ItemProgress {
        progressByItemId[itemId] ?? ItemProgress(
            itemId: itemId,
            positionSeconds: 0,
            durationSeconds: nil,
            completed: nil,
            updatedAtEpochMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    func setPlaybackOptions(_ partial: PlaybackOptions) {
        // Merge: only overwrite fields we can detect as "changed" from defaults? Since Swift lacks partial,
        // we expect the plugin to construct a merged PlaybackOptions object. Keep this method for parity.
        options = partial
        configureRemoteCommandEnablement()
        bumpStateRevision()
        persist()
        notifyStateChange()
    }

    func setRepeatMode(_ mode: String) {
        if let rm = RepeatMode(rawValue: mode) {
            state.repeatMode = rm
            bumpStateRevision()
            persist()
            notifyStateChange()
            refreshNowPlayingPositionOnly()
        }
    }

    func setShuffle(_ enabled: Bool) {
        let wasPlaying = state.status == .playing
        let desiredId = state.currentItemId
        let desiredPos = state.position

        state.shuffle = enabled
        if enabled {
            shuffleQueue = buildInitialShuffleQueue(from: baseQueue, currentItemId: desiredId)
        } else {
            shuffleQueue = nil
        }

        let effective = resolvedEffectiveQueue()
        rebuildQueue(
            items: effective,
            desiredItemId: desiredId,
            desiredIndex: nil,
            desiredPositionSeconds: desiredPos,
            shouldBumpQueueRevision: true
        )
        if wasPlaying { play() }
    }

    // MARK: - Internal: Audio session
    private func resolvedEffectiveQueue() -> [QueueItem] {
        if !state.shuffle { return baseQueue }
        if let sq = shuffleQueue {
            let baseIds = baseQueue.map(\.id)
            let sqIds = sq.map(\.id)
            if sqIds.count == baseIds.count, Set(sqIds) == Set(baseIds) {
                return sq
            }
        }
        // Fallback: rebuild a shuffled order from the base queue.
        shuffleQueue = buildInitialShuffleQueue(from: baseQueue, currentItemId: state.currentItemId)
        return shuffleQueue ?? baseQueue
    }

    private func buildInitialShuffleQueue(from base: [QueueItem], currentItemId: String?) -> [QueueItem] {
        guard base.count >= 2 else { return base }
        let currentId = currentItemId ?? base.first?.id
        let currentIndex = currentId.flatMap { id in base.firstIndex(where: { $0.id == id }) } ?? 0
        let prefix = Array(base.prefix(currentIndex + 1))
        var tail = Array(base.suffix(from: min(currentIndex + 1, base.count)))
        tail.shuffle()
        return prefix + tail
    }

    private func rebuildShuffleQueueAfterBaseChange(currentItemId: String?) -> [QueueItem] {
        guard state.shuffle else { return baseQueue }
        guard baseQueue.count >= 2 else { return baseQueue }

        let baseById: [String: QueueItem] = Dictionary(uniqueKeysWithValues: baseQueue.map { ($0.id, $0) })
        let desiredId = currentItemId ?? state.currentItemId

        let existing = shuffleQueue ?? queue
        var prefixIds: [String] = []
        if let desiredId, let idx = existing.firstIndex(where: { $0.id == desiredId }) {
            prefixIds = existing.prefix(idx + 1).map(\.id).filter { baseById[$0] != nil }
        }

        let prefixItems: [QueueItem] = prefixIds.compactMap { baseById[$0] }
        var remaining: [QueueItem] = baseQueue.filter { !prefixIds.contains($0.id) }
        remaining.shuffle()
        return prefixItems + remaining
    }

    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        } catch {
            // Ignore; playback may still work.
        }
    }

    // MARK: - Queue rebuild + URL resolution

    private func rebuildQueue(
        items: [QueueItem],
        desiredItemId: String?,
        desiredIndex: Int?,
        desiredPositionSeconds: Double?,
        shouldBumpQueueRevision: Bool
    ) {
        stopMetadataPolling()

        // Determine the desired index based on the *logical* incoming items array.
        let targetOriginalIndex: Int = {
            if let desiredItemId, let idx = items.firstIndex(where: { $0.id == desiredItemId }) {
                return idx
            }
            if let desiredIndex {
                return max(0, min(desiredIndex, max(0, items.count - 1)))
            }
            return max(0, min(state.currentIndex, max(0, items.count - 1)))
        }()

        // Resolve media URLs and build a filtered list of playable items, keeping track of original indices.
        let resolvedTuples: [(originalIndex: Int, item: QueueItem, url: URL)] = items.enumerated().compactMap { (index, item) in
            guard let url = resolveMediaUrl(item.src) else { return nil }
            return (originalIndex: index, item: item, url: url)
        }

        // If nothing resolved, clear the queue and keep state consistent.
        if resolvedTuples.isEmpty {
            queue = []
            baseQueue = []
            shuffleQueue = nil

            player.pause()
            player.removeAllItems()
            playerItemsByIndex = [:]

            let desiredPos = max(0, desiredPositionSeconds ?? 0)
            if desiredPos > 0 {
                player.seek(to: CMTime(seconds: desiredPos, preferredTimescale: seekTimescale))
            }

            isStopped = true
            state.status = .stopped
            state.currentIndex = 0
            state.currentItemId = nil
            state.position = desiredPos
            state.duration = nil

            if shouldBumpQueueRevision { bumpQueueRevision() }
            bumpStateRevision()
            persist()

            notifyQueueChange()
            notifyTrackChange()
            notifyStateChange()
            refreshNowPlaying()

            startMetadataPollingIfNeeded()
            return
        }

        // Keep baseQueue/shuffleQueue consistent with the playable set.
        let playableIds = Set(resolvedTuples.map { $0.item.id })
        baseQueue = baseQueue.filter { playableIds.contains($0.id) }
        if let sq = shuffleQueue {
            shuffleQueue = sq.filter { playableIds.contains($0.id) }
        }

        // Map original indices to new indices in the filtered list.
        var originalToFilteredIndex: [Int: Int] = [:]
        for (filteredIndex, tuple) in resolvedTuples.enumerated() {
            originalToFilteredIndex[tuple.originalIndex] = filteredIndex
        }

        // Choose the actual resolved index within the filtered list, preferring the exact item,
        // otherwise the next playable item after it, or the last playable item.
        let resolvedIndex: Int = {
            if let exact = originalToFilteredIndex[targetOriginalIndex] {
                return exact
            }
            if let next = resolvedTuples.first(where: { $0.originalIndex > targetOriginalIndex }),
               let idx = originalToFilteredIndex[next.originalIndex]
            {
                return idx
            }
            if let lastOriginalIndex = resolvedTuples.last?.originalIndex,
               let idx = originalToFilteredIndex[lastOriginalIndex]
            {
                return idx
            }
            return 0
        }()

        // Update the logical queue to only include successfully resolved items.
        queue = resolvedTuples.map { $0.item }
        if state.shuffle {
            shuffleQueue = queue
        }

        state.currentIndex = resolvedIndex
        state.currentItemId = queue.indices.contains(resolvedIndex) ? queue[resolvedIndex].id : nil

        player.pause()
        player.removeAllItems()
        playerItemsByIndex = [:]

        // Build the AVQueuePlayer queue from the filtered, resolvable items using their new indices.
        for (i, tuple) in resolvedTuples.enumerated() {
            let avItem = AVPlayerItem(url: tuple.url)
            avItem.audioTimePitchAlgorithm = .timeDomain
            playerItemsByIndex[i] = avItem
            player.insert(avItem, after: nil)
        }

        // Seek to index by advancing the queue player (AVQueuePlayer doesn't expose random access well).
        // We rebuild by removing items before the desired index.
        if resolvedIndex > 0 {
            for i in 0..<resolvedIndex {
                if let it = playerItemsByIndex[i] {
                    player.remove(it)
                }
                playerItemsByIndex[i] = nil
            }
        }

        let desiredPos = max(0, desiredPositionSeconds ?? 0)
        if desiredPos > 0 {
            player.seek(to: CMTime(seconds: desiredPos, preferredTimescale: seekTimescale))
        }

        isStopped = true
        state.status = .stopped
        state.position = desiredPos
        state.duration = nil

        if shouldBumpQueueRevision { bumpQueueRevision() }
        bumpStateRevision()
        persist()

        notifyQueueChange()
        notifyTrackChange()
        notifyStateChange()
        refreshNowPlaying()

        startMetadataPollingIfNeeded()
    }

    private func patchQueuePreservingCurrentItem(newItems: [QueueItem], desiredCurrentItemId: String?) -> Bool {
        guard let desiredCurrentItemId else { return false }
        guard let currentItem = player.currentItem else { return false }
        guard let assetUrl = (currentItem.asset as? AVURLAsset)?.url else { return false }
        guard let currentIndexInNew = newItems.firstIndex(where: { $0.id == desiredCurrentItemId }) else { return false }
        // Only preserve if the current AVPlayerItem matches the desired queue item src.
        guard resolveMediaUrl(newItems[currentIndexInNew].src) == assetUrl else { return false }

        // Update logical queue and index.
        queue = newItems
        state.currentIndex = currentIndexInNew
        state.currentItemId = desiredCurrentItemId

        // Remove all queued items after current.
        let itemsInQueue = player.items()
        if itemsInQueue.count > 1 {
            for i in stride(from: itemsInQueue.count - 1, through: 1, by: -1) {
                player.remove(itemsInQueue[i])
            }
        }

        // Rebuild mapping for indices at/after current.
        playerItemsByIndex = [:]
        playerItemsByIndex[currentIndexInNew] = currentItem

        // Insert new upcoming items after current.
        var last: AVPlayerItem? = currentItem
        if currentIndexInNew + 1 < newItems.count {
            for idx in (currentIndexInNew + 1)..<newItems.count {
                let qi = newItems[idx]
                guard let url = resolveMediaUrl(qi.src) else { continue }
                let avItem = AVPlayerItem(url: url)
                avItem.audioTimePitchAlgorithm = .timeDomain
                playerItemsByIndex[idx] = avItem
                player.insert(avItem, after: last)
                last = avItem
            }
        }

        bumpQueueRevision()
        persist()
        notifyQueueChange()
        notifyTrackChange()
        notifyStateChange()
        refreshNowPlaying()
        startMetadataPollingIfNeeded()
        return true
    }

    private func resolveMediaUrl(_ src: String) -> URL? {
        if let url = URL(string: src), let scheme = url.scheme, ["http", "https", "file"].contains(scheme) {
            return url
        }
        // Treat as relative to app location.
        if let base = plugin?.bridge?.config.appLocation {
            return base.appendingPathComponent(src)
        }
        return URL(string: src)
    }

    private func resolveArtworkUrl(_ src: String) -> URL? {
        if let url = URL(string: src), let scheme = url.scheme, ["http", "https", "file"].contains(scheme) {
            return url
        }
        if let base = plugin?.bridge?.config.appLocation {
            return base.appendingPathComponent(src)
        }
        return URL(string: src)
    }

    // MARK: - Observers

    private func setupObservers() {
        currentItemObservation = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            guard let self else { return }
            self.handleCurrentItemChanged()
        }

        if timeObserver == nil {
            let interval = CMTime(seconds: 1, preferredTimescale: 1)
            timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.updateStateFromPlayer()
                self.refreshNowPlayingPositionOnly()

                if let itemId = self.state.currentItemId {
                    let progress = ItemProgress(
                        itemId: itemId,
                        positionSeconds: self.state.position,
                        durationSeconds: self.state.duration,
                        completed: nil,
                        updatedAtEpochMs: Int64(Date().timeIntervalSince1970 * 1000)
                    )
                    self.progressByItemId[itemId] = progress
                }

                self.persist()
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleItemDidEnd(_:)),
            name: .AVPlayerItemDidPlayToEndTime,
            object: nil
        )
    }

    private func teardownObservers() {
        if let obs = timeObserver {
            player.removeTimeObserver(obs)
            timeObserver = nil
        }
        currentItemObservation?.invalidate()
        currentItemObservation = nil
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
    }

    private func handleCurrentItemChanged() {
        guard !queue.isEmpty else { return }

        // Map by AVPlayerItem identity (not URL) so multiple items can share the same src.
        if let current = player.currentItem {
            if let matchIndex = playerItemsByIndex.first(where: { $0.value === current })?.key {
                state.currentIndex = matchIndex
                state.currentItemId = queue.indices.contains(matchIndex) ? queue[matchIndex].id : nil
            }
        }

        updateStateFromPlayer()
        bumpStateRevision()
        persist()
        notifyTrackChange()
        notifyStateChange()
        refreshNowPlaying()
        startMetadataPollingIfNeeded()
    }

    @objc private func handleItemDidEnd(_ notification: Notification) {
        guard let endedItem = notification.object as? AVPlayerItem else { return }

        // Identify which index ended
        let endedIndex = playerItemsByIndex.first(where: { $0.value === endedItem })?.key
        guard let idx = endedIndex, queue.indices.contains(idx) else { return }

        // Mark item completed using ended item's duration (avoid auto-advance races).
        let endedDuration: Double? = {
            let d = endedItem.duration.seconds
            if d.isFinite, d > 0 { return d }
            if let declared = queue[idx].duration, declared.isFinite, declared > 0 { return declared }
            return nil
        }()

        let endedPosition: Double = endedDuration ?? {
            let t = endedItem.currentTime().seconds
            if t.isFinite, t > 0 { return t }
            return state.position
        }()

        let itemId = queue[idx].id
        progressByItemId[itemId] = ItemProgress(
            itemId: itemId,
            positionSeconds: endedPosition,
            durationSeconds: endedDuration,
            completed: true,
            updatedAtEpochMs: Int64(Date().timeIntervalSince1970 * 1000)
        )

        let shouldAutoplayNext = options.autoplayNext

        // Repeat semantics.
        if options.enableNextPrev, shouldAutoplayNext, state.repeatMode == .one {
            skipToIndex(idx, positionSeconds: 0)
            play()
            return
        }

        if !shouldAutoplayNext {
            let isFinalItem = idx == queue.count - 1
            if isFinalItem {
                finalizePlaylistConsumption(endedPosition: endedPosition, endedDuration: endedDuration)
                return
            }
            player.pause()
            isStopped = false
            state.status = .paused
            state.position = endedPosition
            state.duration = endedDuration
            bumpStateRevision()
            persist()
            stopMetadataPolling()
            let notifyAfterSeek = { [weak self] in
                guard let self else { return }
                self.notifyStateChange()
                self.refreshNowPlaying()
            }
            if endedPosition > 0 {
                player.seek(to: CMTime(seconds: endedPosition, preferredTimescale: seekTimescale)) { _ in notifyAfterSeek() }
            } else {
                notifyAfterSeek()
            }
            return
        }

        if idx + 1 < queue.count {
            // Advance to next item manually (actionAtItemEnd is .none).
            player.advanceToNextItem()
            state.currentIndex = idx + 1
            state.currentItemId = queue[idx + 1].id
            isStopped = false
            state.status = .playing
            bumpStateRevision()
            persist()
            notifyTrackChange()
            notifyStateChange()
            refreshNowPlaying()
            startMetadataPollingIfNeeded()
            return
        }

        if state.repeatMode == .all, !queue.isEmpty {
            skipToIndex(0, positionSeconds: 0)
            play()
            return
        }

        finalizePlaylistConsumption(endedPosition: endedPosition, endedDuration: endedDuration)
    }

    private func finalizePlaylistConsumption(endedPosition: Double, endedDuration: Double?) {
        player.pause()
        stopMetadataPolling()
        isStopped = true
        state.status = .stopped
        state.position = endedPosition
        state.duration = endedDuration
        state.playlistFinished = true
        bumpStateRevision()
        persist()
        notifyStateChange(retainUntilConsumed: true)
        clearQueue()
    }

    private func updateStateFromPlayer() {
        guard let currentItem = player.currentItem else {
            if player.timeControlStatus == .playing || player.rate > 0 {
                state.status = .playing
            } else if isStopped {
                state.status = .stopped
            } else {
                state.status = .paused
            }
            return
        }

        let pos = currentItem.currentTime().seconds
        if pos.isFinite { state.position = max(0, pos) }

        let duration = currentItem.duration.seconds
        if duration.isFinite, duration > 0 {
            state.duration = duration
        } else {
            state.duration = nil
        }

        if player.timeControlStatus == .playing || player.rate > 0 {
            state.status = .playing
        } else if isStopped {
            state.status = .stopped
        } else {
            state.status = .paused
        }
    }

    // MARK: - Remote Commands + Now Playing

    private func setupRemoteCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()

        playCommandTarget = commandCenter.playCommand.addTarget { [weak self] _ in
            self?.play()
            return .success
        }

        pauseCommandTarget = commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }

        nextTrackCommandTarget = commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.skipToNext()
            return .success
        }

        previousTrackCommandTarget = commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.skipToPrevious()
            return .success
        }

        changePlaybackPositionCommandTarget = commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.seek(positionSeconds: event.positionTime)
            return .success
        }

        skipForwardCommandTarget = commandCenter.skipForwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.seek(positionSeconds: self.state.position + self.options.skipForwardSeconds)
            return .success
        }

        skipBackwardCommandTarget = commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.seek(positionSeconds: max(0, self.state.position - self.options.skipBackwardSeconds))
            return .success
        }

        stopCommandTarget = commandCenter.stopCommand.addTarget { [weak self] _ in
            self?.stop()
            return .success
        }

        configureRemoteCommandEnablement()
    }

    private func configureRemoteCommandEnablement() {
        let commandCenter = MPRemoteCommandCenter.shared()
        let canNext = options.enableNextPrev && state.currentIndex + 1 < queue.count
        let canPrev = options.enableNextPrev && (state.currentIndex > 0 || state.position > options.previousThresholdSeconds)

        commandCenter.nextTrackCommand.isEnabled = canNext
        commandCenter.previousTrackCommand.isEnabled = canPrev
        commandCenter.changePlaybackPositionCommand.isEnabled = options.enableSeekTo && (state.duration ?? 0) > 0
        commandCenter.skipForwardCommand.isEnabled = options.enableSkipForwardBackward
        commandCenter.skipBackwardCommand.isEnabled = options.enableSkipForwardBackward
        commandCenter.stopCommand.isEnabled = options.enableStop

        commandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: options.skipForwardSeconds)]
        commandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: options.skipBackwardSeconds)]
    }

    private func refreshNowPlaying() {
        guard queue.indices.contains(state.currentIndex) else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let item = queue[state.currentIndex]
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: state.position,
            MPNowPlayingInfoPropertyPlaybackRate: state.status == .playing ? state.rate : 0.0
        ]

        if let artist = item.artist { info[MPMediaItemPropertyArtist] = artist }
        if let album = item.album { info[MPMediaItemPropertyAlbumTitle] = album }
        if let duration = state.duration { info[MPMediaItemPropertyPlaybackDuration] = duration }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        configureRemoteCommandEnablement()

        if let artworkSrc = item.artwork, let url = resolveArtworkUrl(artworkSrc) {
            loadArtworkAsync(url)
        }
    }

    private func refreshNowPlayingPositionOnly() {
        var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        updated[MPNowPlayingInfoPropertyElapsedPlaybackTime] = state.position
        updated[MPNowPlayingInfoPropertyPlaybackRate] = state.status == .playing ? state.rate : 0.0
        if let duration = state.duration {
            updated[MPMediaItemPropertyPlaybackDuration] = duration
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
        configureRemoteCommandEnablement()
    }

    private func loadArtworkAsync(_ url: URL) {
        let expectedItemId = state.currentItemId
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                // Only apply if we're still on the same item.
                if self.state.currentItemId != expectedItemId { return }
                var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                updated[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
            }
        }.resume()
    }

    // MARK: - Persistence

    private func persist() {
        guard !isRestoring else { return }
        let persisted = PersistedState(
            schemaVersion: 1,
            queue: queue,
            baseQueue: baseQueue,
            progressByItemId: progressByItemId,
            options: options,
            state: state
        )
        store.save(persisted)
    }

    private func restoreIfAvailable() {
        guard let persisted = store.load(), persisted.schemaVersion == 1 else { return }
        isRestoring = true
        defer { isRestoring = false }

        options = persisted.options
        progressByItemId = persisted.progressByItemId
        state = persisted.state
        baseQueue = persisted.baseQueue

        let effective: [QueueItem] = state.shuffle ? persisted.queue : baseQueue
        shuffleQueue = state.shuffle ? effective : nil

        // Rebuild without bumping revisions.
        rebuildQueue(
            items: effective,
            desiredItemId: persisted.state.currentItemId,
            desiredIndex: persisted.state.currentIndex,
            desiredPositionSeconds: persisted.state.position,
            shouldBumpQueueRevision: false
        )
    }

    // MARK: - Revisions

    private func bumpStateRevision() {
        guard !isRestoring else { return }
        state.stateRevision += 1
    }

    private func bumpQueueRevision() {
        guard !isRestoring else { return }
        state.queueRevision += 1
        state.stateRevision += 1
    }

    // MARK: - Events

    private func notifyStateChange(retainUntilConsumed: Bool = false) {
        plugin?.notifyListeners("stateChange", data: stateToJS(), retainUntilConsumed: retainUntilConsumed)
    }

    private func notifyTrackChange() {
        guard queue.indices.contains(state.currentIndex) else { return }
        let payload: [String: Any] = [
            "queueRevision": state.queueRevision,
            "currentIndex": state.currentIndex,
            "item": queueItemToJS(queue[state.currentIndex])
        ]
        plugin?.notifyListeners("trackChange", data: payload, retainUntilConsumed: false)
    }

    private func notifyQueueChange() {
        plugin?.notifyListeners("queueChange", data: getQueueResult(), retainUntilConsumed: false)
    }

    private func queueItemToJS(_ item: QueueItem) -> [String: Any] {
        var obj: [String: Any] = [
            "id": item.id,
            "src": item.src,
            "title": item.title
        ]
        if let v = item.artist { obj["artist"] = v }
        if let v = item.album { obj["album"] = v }
        if let v = item.artwork { obj["artwork"] = v }
        if let v = item.duration { obj["duration"] = v }
        if let v = item.metadataUpdateUrl { obj["metadataUpdateUrl"] = v }
        if let v = item.metadataUpdateInterval { obj["metadataUpdateInterval"] = v }
        if let v = item.extras { obj["extras"] = jsonValueDictToAny(v) }
        return obj
    }

    private func jsonValueDictToAny(_ dict: [String: JSONValue]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in dict {
            result[key] = jsonValueToAny(value)
        }
        return result
    }

    private func jsonValueToAny(_ value: JSONValue) -> Any {
        switch value {
        case .null:
            return NSNull()
        case .bool(let v):
            return v
        case .number(let v):
            return v
        case .string(let v):
            return v
        case .array(let v):
            return v.map { jsonValueToAny($0) }
        case .object(let v):
            return jsonValueDictToAny(v)
        }
    }

    private func stateToJS() -> [String: Any] {
        var obj: [String: Any] = [
            "stateRevision": state.stateRevision,
            "queueRevision": state.queueRevision,
            "status": state.status.rawValue,
            "currentIndex": state.currentIndex,
            "position": state.position,
            "rate": state.rate,
            "volume": state.volume,
            "repeatMode": state.repeatMode.rawValue,
            "shuffle": state.shuffle
        ]
        obj["currentItemId"] = state.currentItemId as Any
        if let dur = state.duration { obj["duration"] = dur }
        if state.playlistFinished == true {
            obj["playlistFinished"] = true
        }
        return obj
    }

    // MARK: - Stream metadata polling

    private func startMetadataPollingIfNeeded() {
        stopMetadataPolling()
        guard state.status == .playing else { return }
        guard queue.indices.contains(state.currentIndex) else { return }
        let item = queue[state.currentIndex]
        guard let urlStr = item.metadataUpdateUrl, !urlStr.isEmpty else { return }
        let interval = max(5, item.metadataUpdateInterval ?? 15)
        guard let url = URL(string: urlStr) else { return }

        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .background))
        timer.schedule(deadline: .now() + .seconds(interval), repeating: .seconds(interval))
        timer.setEventHandler { [weak self] in
            self?.fetchStreamMetadata(url: url)
        }
        metadataTimer = timer
        timer.resume()
    }

    private func stopMetadataPolling() {
        metadataTimer?.cancel()
        metadataTimer = nil
    }

    private func fetchStreamMetadata(url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data else { return }
            guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }

            let title = obj["title"] as? String
            let artist = obj["artist"] as? String
            let album = obj["album"] as? String
            let artwork = obj["artwork"] as? String

            guard title != nil || artist != nil || album != nil || artwork != nil else { return }

            DispatchQueue.main.async {
                self.applyStreamMetadataUpdate(title: title, artist: artist, album: album, artwork: artwork)
            }
        }.resume()
    }

    private func applyStreamMetadataUpdate(title: String?, artist: String?, album: String?, artwork: String?) {
        guard queue.indices.contains(state.currentIndex) else { return }
        let itemId = state.currentItemId ?? queue[state.currentIndex].id

        var changed: [String: Any] = [:]
        var item = queue[state.currentIndex]

        if let title, title != item.title {
            item.title = title
            changed["title"] = title
        }
        if let artist, artist != item.artist {
            item.artist = artist
            changed["artist"] = artist
        }
        if let album, album != item.album {
            item.album = album
            changed["album"] = album
        }
        if let artwork, artwork != item.artwork {
            item.artwork = artwork
            changed["artwork"] = artwork
        }

        if changed.isEmpty { return }

        // Deduplicate by a simple fingerprint so we don't spam listeners.
        let fingerprint = "\(item.title)|\(item.artist ?? "")|\(item.album ?? "")|\(item.artwork ?? "")"
        if lastMetadataFingerprintByItemId[itemId] == fingerprint { return }
        lastMetadataFingerprintByItemId[itemId] = fingerprint

        queue[state.currentIndex] = item
        if let baseIdx = baseQueue.firstIndex(where: { $0.id == itemId }) {
            baseQueue[baseIdx] = item
        }
        bumpStateRevision()
        persist()

        plugin?.notifyListeners(
            "metadataChange",
            data: [
                "stateRevision": state.stateRevision,
                "itemId": itemId,
                "metadata": changed
            ],
            retainUntilConsumed: false
        )

        refreshNowPlaying()
        notifyQueueChange()
    }
}


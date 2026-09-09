import Foundation

// MARK: - JSONValue

/// Minimal JSON value representation for persisting `QueueItem.extras`.
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v):
            try container.encode(v)
        case .number(let v):
            try container.encode(v)
        case .bool(let v):
            try container.encode(v)
        case .object(let v):
            try container.encode(v)
        case .array(let v):
            try container.encode(v)
        case .null:
            try container.encodeNil()
        }
    }
}

// MARK: - Public models (mirrors `src/definitions.ts`)

enum PlaybackStatus: String, Codable {
    case playing
    case paused
    case stopped
}

enum RepeatMode: String, Codable {
    case off
    case one
    case all
}

struct QueueItem: Codable, Equatable {
    let id: String
    let src: String
    var title: String
    var artist: String?
    var album: String?
    var artwork: String?
    let duration: Double?
    let metadataUpdateUrl: String?
    let metadataUpdateInterval: Int?
    let extras: [String: JSONValue]?
}

struct ItemProgress: Codable, Equatable {
    let itemId: String
    let positionSeconds: Double
    let durationSeconds: Double?
    let completed: Bool?
    let updatedAtEpochMs: Int64
}

struct PlaybackOptions: Codable, Equatable {
    var previousThresholdSeconds: Double = 7
    var skipForwardSeconds: Double = 10
    var skipBackwardSeconds: Double = 10
    var enableNextPrev: Bool = true
    var enableSeekTo: Bool = true
    var enableSkipForwardBackward: Bool = true
    var enableStop: Bool = true
    var autoplayNext: Bool = true
    var androidNotificationSmallIcon: String? = nil

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        previousThresholdSeconds = try c.decodeIfPresent(Double.self, forKey: .previousThresholdSeconds) ?? 7
        skipForwardSeconds = try c.decodeIfPresent(Double.self, forKey: .skipForwardSeconds) ?? 10
        skipBackwardSeconds = try c.decodeIfPresent(Double.self, forKey: .skipBackwardSeconds) ?? 10
        enableNextPrev = try c.decodeIfPresent(Bool.self, forKey: .enableNextPrev) ?? true
        enableSeekTo = try c.decodeIfPresent(Bool.self, forKey: .enableSeekTo) ?? true
        enableSkipForwardBackward = try c.decodeIfPresent(Bool.self, forKey: .enableSkipForwardBackward) ?? true
        enableStop = try c.decodeIfPresent(Bool.self, forKey: .enableStop) ?? true
        autoplayNext = try c.decodeIfPresent(Bool.self, forKey: .autoplayNext) ?? true
        androidNotificationSmallIcon = try c.decodeIfPresent(String.self, forKey: .androidNotificationSmallIcon)
    }
}

struct PlayerState: Codable, Equatable {
    var stateRevision: Int64 = 0
    var queueRevision: Int64 = 0
    var status: PlaybackStatus = .stopped
    var currentIndex: Int = 0
    var currentItemId: String?
    var position: Double = 0
    var duration: Double?
    var rate: Double = 1.0
    /// Volume in 0..100.
    var volume: Double = 100
    var repeatMode: RepeatMode = .off
    var shuffle: Bool = false
    /// One-shot; nil after terminal `stateChange` is built and nil in `clearQueue`.
    var playlistFinished: Bool? = nil
}

struct PersistedState: Codable {
    var schemaVersion: Int = 1
    var queue: [QueueItem]
    /// Base (unshuffled) queue order.
    var baseQueue: [QueueItem]
    var progressByItemId: [String: ItemProgress]
    var options: PlaybackOptions
    var state: PlayerState
    /// Wall-clock time this was written, ms since epoch. Missing (older persisted data) is
    /// treated as 0 — i.e. too stale to auto-restore, rather than assumed fresh.
    var persistedAtEpochMs: Double = 0

    init(
        schemaVersion: Int,
        queue: [QueueItem],
        baseQueue: [QueueItem],
        progressByItemId: [String: ItemProgress],
        options: PlaybackOptions,
        state: PlayerState,
        persistedAtEpochMs: Double
    ) {
        self.schemaVersion = schemaVersion
        self.queue = queue
        self.baseQueue = baseQueue
        self.progressByItemId = progressByItemId
        self.options = options
        self.state = state
        self.persistedAtEpochMs = persistedAtEpochMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        queue = try c.decode([QueueItem].self, forKey: .queue)
        baseQueue = try c.decode([QueueItem].self, forKey: .baseQueue)
        progressByItemId = try c.decode([String: ItemProgress].self, forKey: .progressByItemId)
        options = try c.decode(PlaybackOptions.self, forKey: .options)
        state = try c.decode(PlayerState.self, forKey: .state)
        persistedAtEpochMs = try c.decodeIfPresent(Double.self, forKey: .persistedAtEpochMs) ?? 0
    }
}


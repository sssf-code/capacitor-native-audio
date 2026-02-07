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
    var enableStop: Bool = true
    var androidNotificationSmallIcon: String? = nil
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
}

struct PersistedState: Codable {
    var schemaVersion: Int = 1
    var queue: [QueueItem]
    var progressByItemId: [String: ItemProgress]
    var options: PlaybackOptions
    var state: PlayerState
}


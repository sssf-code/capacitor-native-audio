import Foundation

final class QueueStore {
    private let defaults: UserDefaults
    private let key = "SsfCapacitorNativeAudio.PersistedState.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> PersistedState? {
        guard let data = defaults.data(forKey: key) else { return nil }
        do {
            return try JSONDecoder().decode(PersistedState.self, from: data)
        } catch {
            return nil
        }
    }

    /// Whether the currently-persisted blob already has a `persistedAtEpochMs` key, i.e.
    /// whether it was written by a version of this plugin that has staleness tracking.
    /// `PersistedState.persistedAtEpochMs` itself can't answer this - it always decodes to a
    /// value (falling back to "now" when absent) - so callers that need to backstamp legacy
    /// state exactly once check this directly against the raw stored JSON instead.
    func hasPersistedAtEpochMs() -> Bool {
        guard let data = defaults.data(forKey: key) else { return false }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["persistedAtEpochMs"] != nil
    }

    func save(_ persisted: PersistedState) {
        do {
            let data = try JSONEncoder().encode(persisted)
            defaults.set(data, forKey: key)
        } catch {
            // Ignore persistence errors; playback should still work.
        }
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}


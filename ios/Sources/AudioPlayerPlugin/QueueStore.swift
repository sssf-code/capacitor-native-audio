import Foundation

final class QueueStore {
    private let defaults: UserDefaults
    private let key = "SSFCapacitorNativeAudio.PersistedState.v1"

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


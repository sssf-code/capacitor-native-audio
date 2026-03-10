import Capacitor
import Foundation

@objc(AudioPlayerPlugin)
public class AudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioPlayerPlugin"
    public let jsName = "AudioPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addQueueItems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeQueueItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "moveQueueItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToNext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToPrevious", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setItemProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getItemProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPlaybackOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRepeatMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShuffle", returnType: CAPPluginReturnPromise)
    ]

    private var queuePlayer: NativeQueuePlayer?

    override public func load() {
        super.load()
        // If the plugin is reloaded, ensure we tear down the old instance cleanly.
        queuePlayer?.release()
        queuePlayer = NativeQueuePlayer(plugin: self)
    }

    deinit {
        queuePlayer?.release()
    }

    // MARK: - Queue

    @objc func setQueue(_ call: CAPPluginCall) {
        do {
            let parsed = try parseQueueItems(call)
            let startIndex = call.getInt("startIndex")
            let startPos = call.getDouble("startPositionSeconds")
            let autoplay = call.getBool("autoplay")
            queuePlayer?.setQueue(items: parsed, startIndex: startIndex, startPositionSeconds: startPos, autoplay: autoplay)
            call.resolve()
        } catch {
            call.reject("There was an issue setting the queue.", nil, error)
        }
    }

    @objc func syncQueue(_ call: CAPPluginCall) {
        do {
            let parsed = try parseQueueItems(call)
            let mode = call.getString("mode") ?? "replace"
            let expectedQueueRevision = call.getInt("expectedQueueRevision")
            let force = call.getBool("force") ?? false

            if let expectedQueueRevision, !force {
                let current = Int(queuePlayer?.state.queueRevision ?? 0)
                if expectedQueueRevision != current {
                    call.reject("Queue revision mismatch (expected \(expectedQueueRevision), have \(current)).")
                    return
                }
            }

            let currentItemId = call.getString("currentItemId")
            let startIndex = call.getInt("startIndex")
            let startPos = call.getDouble("startPositionSeconds")
            let autoplay = call.getBool("autoplay")
            queuePlayer?.syncQueue(mode: mode, items: parsed, currentItemId: currentItemId, startIndex: startIndex, startPositionSeconds: startPos, autoplay: autoplay)
            let queueRevision = queuePlayer?.state.queueRevision ?? 0
            call.resolve(["queueRevision": queueRevision])
        } catch {
            call.reject("There was an issue syncing the queue.", nil, error)
        }
    }

    @objc func getQueue(_ call: CAPPluginCall) {
        call.resolve(queuePlayer?.getQueueResult() ?? ["queueRevision": 0, "items": [], "currentIndex": 0, "currentItemId": NSNull()])
    }

    @objc func addQueueItems(_ call: CAPPluginCall) {
        do {
            let parsed = try parseQueueItems(call)
            let atIndex = call.getInt("atIndex")
            queuePlayer?.addQueueItems(items: parsed, atIndex: atIndex)
            call.resolve()
        } catch {
            call.reject("There was an issue adding queue items.", nil, error)
        }
    }

    @objc func removeQueueItem(_ call: CAPPluginCall) {
        guard let itemId = call.getString("itemId") else {
            call.reject("itemId is required.")
            return
        }
        queuePlayer?.removeQueueItem(itemId: itemId)
        call.resolve()
    }

    @objc func moveQueueItem(_ call: CAPPluginCall) {
        guard let fromIndex = call.getInt("fromIndex"), let toIndex = call.getInt("toIndex") else {
            call.reject("fromIndex and toIndex are required.")
            return
        }
        queuePlayer?.moveQueueItem(fromIndex: fromIndex, toIndex: toIndex)
        call.resolve()
    }

    @objc func clearQueue(_ call: CAPPluginCall) {
        queuePlayer?.clearQueue()
        call.resolve()
    }

    @objc func play(_ call: CAPPluginCall) {
        queuePlayer?.play()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        queuePlayer?.pause()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        queuePlayer?.stop()
        call.resolve()
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let pos = call.getDouble("positionSeconds") else {
            call.reject("positionSeconds is required.")
            return
        }
        queuePlayer?.seek(positionSeconds: pos)
        call.resolve()
    }

    @objc func skipToNext(_ call: CAPPluginCall) {
        queuePlayer?.skipToNext()
        call.resolve()
    }

    @objc func skipToPrevious(_ call: CAPPluginCall) {
        queuePlayer?.skipToPrevious()
        call.resolve()
    }

    @objc func skipToIndex(_ call: CAPPluginCall) {
        guard let index = call.getInt("index") else {
            call.reject("index is required.")
            return
        }
        let pos = call.getDouble("positionSeconds")
        queuePlayer?.skipToIndex(index, positionSeconds: pos)
        call.resolve()
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        guard let volume = call.getDouble("volume") else {
            call.reject("volume is required.")
            return
        }
        queuePlayer?.setVolume(volume)
        call.resolve()
    }

    @objc func setRate(_ call: CAPPluginCall) {
        guard let rate = call.getDouble("rate") else {
            call.reject("rate is required.")
            return
        }
        queuePlayer?.setRate(rate)
        call.resolve()
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(queuePlayer?.getStateResult() ?? [
            "stateRevision": 0,
            "queueRevision": 0,
            "status": "stopped",
            "currentIndex": 0,
            "currentItemId": NSNull(),
            "position": 0,
            "rate": 1,
            "volume": 100,
            "repeatMode": "off",
            "shuffle": false
        ])
    }

    @objc func setItemProgress(_ call: CAPPluginCall) {
        guard let itemId = call.getString("itemId"),
              let positionSeconds = call.getDouble("positionSeconds")
        else {
            call.reject("itemId and positionSeconds are required.")
            return
        }
        let durationSeconds = call.getDouble("durationSeconds")
        let completed = call.getBool("completed")
        queuePlayer?.setItemProgress(itemId: itemId, positionSeconds: positionSeconds, durationSeconds: durationSeconds, completed: completed)
        call.resolve()
    }

    @objc func getItemProgress(_ call: CAPPluginCall) {
        guard let itemId = call.getString("itemId") else {
            call.reject("itemId is required.")
            return
        }
        let prog = queuePlayer?.getItemProgress(itemId: itemId)
        call.resolve([
            "itemId": prog?.itemId ?? itemId,
            "positionSeconds": prog?.positionSeconds ?? 0,
            "durationSeconds": prog?.durationSeconds as Any,
            "completed": prog?.completed as Any,
            "updatedAtEpochMs": prog?.updatedAtEpochMs ?? Int64(Date().timeIntervalSince1970 * 1000)
        ])
    }

    @objc func setPlaybackOptions(_ call: CAPPluginCall) {
        // Merge into current options.
        guard let qp = queuePlayer else { call.resolve(); return }
        var updated = qp.options
        if let v = call.getDouble("previousThresholdSeconds") { updated.previousThresholdSeconds = v }
        if let v = call.getDouble("skipForwardSeconds") { updated.skipForwardSeconds = v }
        if let v = call.getDouble("skipBackwardSeconds") { updated.skipBackwardSeconds = v }
        if let v = call.getBool("enableNextPrev") { updated.enableNextPrev = v }
        if let v = call.getBool("enableSeekTo") { updated.enableSeekTo = v }
        if let v = call.getBool("enableSkipForwardBackward") { updated.enableSkipForwardBackward = v }
        if let v = call.getBool("enableStop") { updated.enableStop = v }
        if let v = call.getBool("autoplayNext") { updated.autoplayNext = v }
        if let v = call.getString("androidNotificationSmallIcon") { updated.androidNotificationSmallIcon = v }
        qp.setPlaybackOptions(updated)
        call.resolve()
    }

    @objc func getPlaybackOptions(_ call: CAPPluginCall) {
        guard let qp = queuePlayer else { call.resolve([:]); return }
        call.resolve([
            "previousThresholdSeconds": qp.options.previousThresholdSeconds,
            "skipForwardSeconds": qp.options.skipForwardSeconds,
            "skipBackwardSeconds": qp.options.skipBackwardSeconds,
            "enableNextPrev": qp.options.enableNextPrev,
            "enableSeekTo": qp.options.enableSeekTo,
            "enableSkipForwardBackward": qp.options.enableSkipForwardBackward,
            "enableStop": qp.options.enableStop,
            "autoplayNext": qp.options.autoplayNext,
            "androidNotificationSmallIcon": qp.options.androidNotificationSmallIcon as Any
        ])
    }

    @objc func setRepeatMode(_ call: CAPPluginCall) {
        guard let qp = queuePlayer else { call.resolve(); return }
        guard let repeatMode = call.getString("repeatMode") else {
            call.reject("repeatMode is required.")
            return
        }
        qp.setRepeatMode(repeatMode)
        call.resolve()
    }

    @objc func setShuffle(_ call: CAPPluginCall) {
        guard let qp = queuePlayer else { call.resolve(); return }
        guard let shuffle = call.getBool("shuffle") else {
            call.reject("shuffle is required.")
            return
        }
        qp.setShuffle(shuffle)
        call.resolve()
    }

    // MARK: - Parsing helpers

    private func parseQueueItems(_ call: CAPPluginCall) throws -> [QueueItem] {
        guard let arr = call.getArray("items") else { return [] }
        var out: [QueueItem] = []
        for (index, any) in arr.enumerated() {
            guard let obj = any as? [String: Any] else {
                throw NSError(
                    domain: "AudioPlayerPlugin",
                    code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Queue item at index \(index) is not an object."]
                )
            }
            guard let id = obj["id"] as? String else {
                throw NSError(
                    domain: "AudioPlayerPlugin",
                    code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Queue item at index \(index) is missing required field 'id'."]
                )
            }
            guard let src = obj["src"] as? String else {
                throw NSError(
                    domain: "AudioPlayerPlugin",
                    code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Queue item at index \(index) is missing required field 'src'."]
                )
            }
            guard let title = obj["title"] as? String else {
                throw NSError(
                    domain: "AudioPlayerPlugin",
                    code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Queue item at index \(index) is missing required field 'title'."]
                )
            }

            var extras: [String: JSONValue]?
            if let raw = obj["extras"] {
                if raw is NSNull {
                    extras = nil
                } else if let extrasObj = raw as? [String: Any] {
                    extras = try parseExtras(extrasObj)
                } else {
                    throw NSError(
                        domain: "AudioPlayerPlugin",
                        code: 400,
                        userInfo: [NSLocalizedDescriptionKey: "Queue item at index \(index) field 'extras' must be an object."]
                    )
                }
            }

            let item = QueueItem(
                id: id,
                src: src,
                title: title,
                artist: obj["artist"] as? String,
                album: obj["album"] as? String,
                artwork: obj["artwork"] as? String,
                duration: obj["duration"] as? Double,
                metadataUpdateUrl: obj["metadataUpdateUrl"] as? String,
                metadataUpdateInterval: obj["metadataUpdateInterval"] as? Int,
                extras: extras
            )
            out.append(item)
        }
        return out
    }

    private func parseExtras(_ obj: [String: Any]) throws -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for (key, value) in obj {
            result[key] = try convertToJSONValue(value)
        }
        return result
    }

    private func convertToJSONValue(_ value: Any) throws -> JSONValue {
        if value is NSNull { return .null }

        // JSONSerialization/Capacitor often uses NSNumber for both Bool and number.
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                return .bool(n.boolValue)
            }
            return .number(n.doubleValue)
        }
        if let s = value as? String { return .string(s) }
        if let arr = value as? [Any] { return .array(try arr.map { try convertToJSONValue($0) }) }
        if let dict = value as? [String: Any] {
            var out: [String: JSONValue] = [:]
            for (k, v) in dict {
                out[k] = try convertToJSONValue(v)
            }
            return .object(out)
        }

        throw NSError(
            domain: "AudioPlayerPlugin",
            code: 400,
            userInfo: [NSLocalizedDescriptionKey: "Unsupported type in extras: \(type(of: value))"]
        )
    }
}

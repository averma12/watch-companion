// Prototype: listen with the microphone and print where in a film the audio is, using a ShazamKit
// custom catalog built from the film's own file. Matching is on-device; no audio leaves the Mac.
//
//   listener <film.shazamcatalog> [seconds]
//   listener <film.shazamcatalog> --signature <clip.shazamsignature>   (match a file, no microphone)
//
// Prints one JSON line per match: {"offset": <seconds into the film now>, "matchOffset": …,
// "skew": …, "title": …, "t": <unix time>}, or {"noMatch": true, …}. Stops after `seconds`
// (default 30).
import Foundation
import ShazamKit

@main
struct Listener {
    static func emit(_ object: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
    }

    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            FileHandle.standardError.write("usage: listener <catalog.shazamcatalog> [seconds]\n".data(using: .utf8)!)
            exit(2)
        }
        let catalog = SHCustomCatalog()
        do {
            try catalog.add(from: URL(fileURLWithPath: args[1]))
        } catch {
            emit(["error": "catalog: \(error.localizedDescription)"])
            exit(1)
        }
        if args.count >= 4 && args[2] == "--signature" {
            do {
                let signature = try SHSignature(dataRepresentation: Data(contentsOf: URL(fileURLWithPath: args[3])))
                let result = await SHSession(catalog: catalog).result(from: signature)
                switch result {
                case .match(let match):
                    for item in match.mediaItems {
                        emit(["matchOffset": item.matchOffset, "skew": item.frequencySkew, "title": item.title ?? "",
                              "signatureSeconds": signature.duration])
                    }
                case .noMatch: emit(["noMatch": true])
                case .error(let error, _): emit(["error": error.localizedDescription])
                }
            } catch {
                emit(["error": "signature: \(error.localizedDescription)"])
            }
            return
        }
        let seconds = args.count >= 3 ? Double(args[2]) ?? 30 : 30
        let session = SHManagedSession(catalog: catalog)
        let started = Date()
        emit(["listening": true, "seconds": seconds])

        let task = Task {
            for await result in session.results {
                let t = Date().timeIntervalSince1970
                switch result {
                case .match(let match):
                    for item in match.mediaItems {
                        emit(["offset": item.predictedCurrentMatchOffset, "matchOffset": item.matchOffset,
                              "skew": item.frequencySkew, "title": item.title ?? "", "t": t,
                              "elapsed": Date().timeIntervalSince(started)])
                    }
                case .noMatch:
                    emit(["noMatch": true, "t": t, "elapsed": Date().timeIntervalSince(started)])
                case .error(let error, _):
                    emit(["error": error.localizedDescription, "t": t])
                }
            }
        }
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        session.cancel()
        task.cancel()
    }
}
